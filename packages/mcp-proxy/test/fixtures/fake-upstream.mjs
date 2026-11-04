#!/usr/bin/env node
/**
 * A minimal MCP server that writes down everything it is asked to do.
 *
 * The record is the point. A test that only checks the client received an error cannot
 * tell a refusal apart from a tool that ran and then failed. This server appends every
 * message it receives to the file named by UPSTREAM_LOG, so a test can assert that a
 * refused call is absent from it: the tool was never reached, which is the only claim
 * an enforcement point is making.
 *
 * It speaks the transport and nothing more: newline-delimited JSON on stdin and stdout,
 * nothing but MCP messages on stdout, logging to stderr.
 */
import { appendFileSync } from 'node:fs';

const LOG = process.env.UPSTREAM_LOG;

const TOOLS = [
  { name: 'read_invoice', description: 'Read one supplier invoice.' },
  { name: 'ledger_search', description: 'Search the general ledger.' },
  { name: 'send_email', description: 'Send an email.' },
  { name: 'issue_payment', description: 'Pay a supplier.' },
  { name: 'http_request', description: 'Fetch an arbitrary URL.' },
];

function note(message) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify(message)}\n`, 'utf8');
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  note(message);

  const { id, method, params } = message;
  // A notification has no id and gets no reply.
  if (id === undefined || id === null) return;

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    // Deliberately eager: this server has no opinion about what it should do. That is
    // the whole premise. If a call reaches here, it happens.
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `ran ${params?.name} with ${JSON.stringify(params?.arguments ?? {})}` }] },
    });
    return;
  }

  if (method === 'server/discover') {
    send({ jsonrpc: '2.0', id, result: { supportedVersions: ['2026-07-28'], serverInfo: { name: 'fake-upstream' } } });
    return;
  }

  if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [{ uri: 'file:///ledger.csv', name: 'ledger' }] } });
    return;
  }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no such method ${method}` } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) {
      try {
        handle(JSON.parse(line));
      } catch {
        note({ unparseable: line });
      }
    }
    index = buffer.indexOf('\n');
  }
});

// Exiting on EOF is the portable graceful shutdown the transport specifies.
process.stdin.on('end', () => {
  process.stderr.write('fake-upstream: stdin closed, exiting\n');
  process.exit(0);
});
