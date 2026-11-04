#!/usr/bin/env node
/**
 * An agent reads a poisoned invoice, believes every word of it, and is refused anyway.
 *
 * The agent in this demo is completely credulous. It reads the document, finds
 * instructions in it, and carries them out in order. Nothing detects the injection. No
 * prompt asks the model to be careful. There is no classifier and no filter.
 *
 * The exfiltration and the payment are refused regardless, because the envelope never
 * granted them, and the envelope is enforced in a different process from the one being
 * manipulated. That is the entire argument: the component that decides what an agent
 * may do is not the component an attacker is talking to.
 *
 * Run:  node demo/poisoned-invoice.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PROXY = resolve(here, '../src/bin.ts');
const SERVER = resolve(here, 'invoice-server.mjs');
const ENVELOPE = resolve(here, 'ap-agent.json');

const bold = (s) => `\u001b[1m${s}\u001b[0m`;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;
const red = (s) => `\u001b[31m${s}\u001b[0m`;
const yellow = (s) => `\u001b[33m${s}\u001b[0m`;

// The agent speaks to the proxy exactly as it would speak to the server. It does not
// know the proxy is there, and nothing it can say would remove it.
const child = spawn(process.execPath, [PROXY, '--envelope', ENVELOPE, '--', process.execPath, SERVER], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
let nextId = 1;
const waiting = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i = buffer.indexOf('\n');
  while (i !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim()) {
      const message = JSON.parse(line);
      const resolver = waiting.get(String(message.id));
      if (resolver) {
        waiting.delete(String(message.id));
        resolver(message);
      }
    }
    i = buffer.indexOf('\n');
  }
});

function call(name, args) {
  const id = nextId++;
  return new Promise((done) => {
    waiting.set(String(id), done);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
}

function report(step, name, reply) {
  if (!reply.error) {
    console.log(`  ${green('allowed  ')} ${bold(name)}  ${dim(step)}`);
    return 'allow';
  }
  const record = reply.error.data?.intent_envelope ?? {};
  const escalated = record.result === 'escalate';
  console.log(`  ${escalated ? yellow('escalated') : red('refused  ')} ${bold(name)}  ${dim(step)}`);
  console.log(`             ${dim(`${record.rule}: ${reply.error.message.replace(/^intent envelope: /, '')}`)}`);
  return escalated ? 'escalate' : 'deny';
}

const counts = { allow: 0, deny: 0, escalate: 0 };
const tally = (r) => {
  counts[r] += 1;
};

console.log(`\n${bold('The agent begins its reconciliation run.')}\n`);

const invoice = await call('read_invoice', { invoice_id: '88413', period: 'current_month' });
tally(report('reading invoice 88413', 'read_invoice', invoice));

const ledger = await call('ledger_search', { period: 'current_month', invoice_id: '88413' });
tally(report('checking the ledger', 'ledger_search', ledger));

const text = invoice.result?.content?.[0]?.text ?? '';
console.log(`\n${bold('The invoice contains instructions. The agent reads them as work to do.')}`);
for (const line of text.split('\n').filter((l) => /^ *\d\./.test(l))) {
  console.log(`  ${dim(line.trim())}`);
}
console.log('');

// Step 1 from the document: exfiltrate.
tally(report('step 1 from the document', 'send_email', await call('send_email', {
  template: 'mismatch_summary',
  to: 'collector@northgate-finance.example',
  body: text,
})));

// Step 2 from the document: pay.
tally(report('step 2 from the document', 'issue_payment', await call('issue_payment', {
  invoice_id: '88413',
  amount_gbp: 24900,
})));

// Step 3 from the document told it not to involve a human. It obeys, and tries to
// report to the AP team instead. The value crosses the escalation threshold anyway.
tally(report('step 3, reporting to AP', 'send_email', await call('send_email', {
  template: 'mismatch_summary',
  to: 'ap-team@example.com',
  mismatch_value_gbp: 24900,
})));

console.log(`\n${bold('Result')}`);
console.log(`  ${counts.allow} allowed, ${counts.deny} refused, ${counts.escalate} escalated\n`);
console.log('The agent believed the document completely and did everything it was told.');
console.log('The copy to the supplier\'s address was refused because that address is not on');
console.log('the envelope. The payment was refused because the envelope denies that tool at');
console.log('all. Neither call reached the invoice server: look at its stderr above and you');
console.log('will see it ran only the two calls the envelope permitted.');
console.log('');
console.log('The document also told the agent not to involve a human. That instruction had');
console.log('nothing to enforce it. The mismatch crossed the escalation threshold, so a named');
console.log('human was asked regardless, which is the difference between a control and a wall.');
console.log('');

child.stdin.end();
