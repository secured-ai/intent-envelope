/**
 * Enforce an intent envelope on an MCP server, in the wire protocol itself.
 *
 * The command in bin.ts is the usual way to use this. These exports are for embedding
 * the relay in a host that already owns its own process and streams.
 */

export { ConfigError, USAGE, parse, type Config } from './config.ts';
export { fileLedger, memoryLedger, type Ledger } from './ledger.ts';
export { DENIED, ESCALATION_REQUIRED, Relay, type RelayOptions } from './relay.ts';

export const VERSION = '0.2.0';
