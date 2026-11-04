#!/usr/bin/env node
/**
 * The command an MCP client launches in place of the server it wants governed.
 *
 * Exit codes: 0 if the upstream exited cleanly, the upstream's own code if it did not,
 * and 2 for a configuration problem here. A client that cannot tell the difference
 * between "the server failed" and "the envelope was unreadable" cannot be debugged.
 */

import { spawn } from 'node:child_process';

import { ConfigError, parse } from './config.ts';
import { fileLedger, memoryLedger } from './ledger.ts';
import { Relay } from './relay.ts';

const log = (message: string) => process.stderr.write(`[intent-envelope] ${message}\n`);

function main(): void {
  let config;
  try {
    config = parse(process.argv.slice(2), process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    // A schema failure arrives here. It names the field, which is the useful part.
    process.stderr.write(`[intent-envelope] the envelope is not valid: ${(error as Error).message}\n`);
    process.exit(2);
  }

  const { envelope, command, args } = config;
  log(`enforcing ${envelope.id} revision ${envelope.revision ?? 1} on: ${command} ${args.join(' ')}`);

  const upstream = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  upstream.on('error', (error) => {
    log(`cannot start the server: ${error.message}`);
    process.exit(2);
  });

  const ledger = config.ledgerPath ? fileLedger(config.ledgerPath, log) : memoryLedger();
  const relay = new Relay({
    envelope,
    ledger,
    upstream,
    input: process.stdin,
    output: process.stdout,
    log,
    filterToolList: config.filterToolList,
  });
  relay.start();

  upstream.on('exit', (code, signal) => {
    const counts = relay.summary();
    log(`${counts.allow} allowed, ${counts.deny} refused, ${counts.escalate} escalated`);
    if (config.ledgerPath) log(`ledger: ${config.ledgerPath}`);
    process.exit(signal ? 1 : (code ?? 0));
  });
}

main();
