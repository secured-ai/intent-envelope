/**
 * Where the envelope and the upstream server come from.
 *
 * Both are supplied by whoever launches this process, never by the agent running
 * behind it and never by anything the upstream server says. The envelope is read from
 * disk once, before the first message is accepted, and is not re-read. There is no
 * message an agent can send that changes what it is allowed to do.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validate, type Envelope } from 'intent-envelope';

export interface Config {
  envelope: Envelope;
  envelopePath: string;
  command: string;
  args: string[];
  ledgerPath?: string;
  filterToolList: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const USAGE = `intent-envelope-mcp: enforce an intent envelope on an MCP server

  intent-envelope-mcp --envelope <path> [options] -- <server-command> [server-args...]

Options
  --envelope <path>    the envelope to enforce (or INTENT_ENVELOPE)
  --ledger <path>      append decisions here as JSON lines (or INTENT_ENVELOPE_LEDGER)
  --no-filter-tools    advertise every upstream tool, refusing the ones not granted
  --help

Everything after -- is the server to govern, run as a child process.

  intent-envelope-mcp --envelope ./ap-agent.json -- npx -y @acme/invoice-mcp

Point your MCP client at this command instead of the server's own. Nothing else about
the client changes.`;

/**
 * Parse argv in the shape `[options] -- command args...`.
 *
 * The separator is required. Guessing where options end and the server command begins
 * invites a mistake in which an option meant for this process is handed to the server,
 * or worse, the reverse.
 */
export function parse(argv: string[], env: Record<string, string | undefined> = {}): Config {
  const separator = argv.indexOf('--');
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const rest = separator === -1 ? [] : argv.slice(separator + 1);

  let envelopePath = env.INTENT_ENVELOPE;
  let ledgerPath = env.INTENT_ENVELOPE_LEDGER;
  let filterToolList = true;

  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === '--envelope') envelopePath = flags[++i];
    else if (flag === '--ledger') ledgerPath = flags[++i];
    else if (flag === '--no-filter-tools') filterToolList = false;
    else if (flag === '--help' || flag === '-h') throw new ConfigError(USAGE);
    else throw new ConfigError(`unknown option ${flag}\n\n${USAGE}`);
  }

  if (!envelopePath) throw new ConfigError(`no envelope given\n\n${USAGE}`);
  if (rest.length === 0) throw new ConfigError(`no server command given after --\n\n${USAGE}`);

  const path = resolve(envelopePath);
  let envelope: Envelope;
  try {
    envelope = JSON.parse(readFileSync(path, 'utf8')) as Envelope;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`cannot read the envelope at ${path}: ${reason}`);
  }

  // Fail closed. An enforcement point that starts with an envelope it cannot understand
  // is worse than one that does not start, because the client will assume it is running.
  validate(envelope);

  return { envelope, envelopePath: path, command: rest[0], args: rest.slice(1), ledgerPath, filterToolList };
}
