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
import * as core from 'intent-envelope';
import { validate, type Envelope } from 'intent-envelope';

/** What a component declares. Mirrors intent-envelope 0.3's ComponentManifest. */
export interface ComponentManifest {
  name: string;
  version?: string;
  tools: string[];
  egress?: string[];
  data?: string[];
  processors?: string[];
}

export interface Config {
  envelope: Envelope;
  envelopePath: string;
  command: string;
  args: string[];
  ledgerPath?: string;
  filterToolList: boolean;
  /** 0.2. The manifest of the server being governed, admitted against the envelope at start. */
  component?: ComponentManifest;
  /** Where escalations go to wait for a person. Absent: they are refused. */
  supervisor?: {
    url: string;
    callerId: string;
    privateKeyPem: string;
    supervisorPublicKeyPem: string;
  };
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
  --component <path>   the server's manifest: the tools it brings and the hosts it
                       reaches. Refused at start if any of it is outside the envelope
                       (or INTENT_ENVELOPE_COMPONENT). Required when the envelope sets
                       components.require_manifest.
  --help

Escalations wait for a person when a Supervisor Check service is given (all four):
  --supervisor <url>          the supervisor (or INTENT_ENVELOPE_SUPERVISOR)
  --supervisor-caller <id>    this host's caller id there (or INTENT_ENVELOPE_SUPERVISOR_CALLER)
  --supervisor-key <path>     this host's Ed25519 private key (or INTENT_ENVELOPE_SUPERVISOR_KEY)
  --supervisor-pub <path>     the supervisor's public key, pinned (or INTENT_ENVELOPE_SUPERVISOR_PUB)
Without them, an escalated call is refused with the name of who must approve it.

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
  let componentPath = env.INTENT_ENVELOPE_COMPONENT;
  let supUrl = env.INTENT_ENVELOPE_SUPERVISOR;
  let supCaller = env.INTENT_ENVELOPE_SUPERVISOR_CALLER;
  let supKey = env.INTENT_ENVELOPE_SUPERVISOR_KEY;
  let supPub = env.INTENT_ENVELOPE_SUPERVISOR_PUB;

  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === '--envelope') envelopePath = flags[++i];
    else if (flag === '--ledger') ledgerPath = flags[++i];
    else if (flag === '--no-filter-tools') filterToolList = false;
    else if (flag === '--component') componentPath = flags[++i];
    else if (flag === '--supervisor') supUrl = flags[++i];
    else if (flag === '--supervisor-caller') supCaller = flags[++i];
    else if (flag === '--supervisor-key') supKey = flags[++i];
    else if (flag === '--supervisor-pub') supPub = flags[++i];
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

  // 0.2 component admission. Checked here, before the server is even started, so a
  // component that would join read access to outbound reach never runs at all.
  let component: ComponentManifest | undefined;
  if (componentPath) {
    try {
      component = JSON.parse(readFileSync(resolve(componentPath), 'utf8')) as ComponentManifest;
    } catch (error) {
      throw new ConfigError(`cannot read the component manifest at ${componentPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Admission lives in the core package from 0.3. With an older core installed the
    // manifest cannot be checked, and an unchecked manifest is not an admission.
    const admit = (core as unknown as { admitComponent?: (e: Envelope, m: ComponentManifest) => { admitted: boolean; reasons: string[] } }).admitComponent;
    if (typeof admit !== 'function') {
      throw new ConfigError('--component needs intent-envelope 0.3 or newer installed beside this proxy');
    }
    const admission = admit(envelope, component);
    if (!admission.admitted) {
      throw new ConfigError(`the component ${component?.name ?? '(unnamed)'} is not admitted by ${envelope.id}:\n  - ${admission.reasons.join('\n  - ')}`);
    }
  } else if ((envelope as { components?: { require_manifest?: boolean } }).components?.require_manifest) {
    throw new ConfigError(`${envelope.id} requires a component manifest (components.require_manifest), and none was given: pass --component`);
  }

  // All or none. Half a supervisor configuration would read as "escalations wait" to the
  // operator and behave as "escalations are refused", or worse, fail on the first one.
  const given = [supUrl, supCaller, supKey, supPub].filter(Boolean).length;
  let supervisor: Config['supervisor'];
  if (given > 0 && given < 4) {
    throw new ConfigError('--supervisor, --supervisor-caller, --supervisor-key and --supervisor-pub go together: give all four or none');
  }
  if (given === 4) {
    const read = (what: string, file: string) => {
      try {
        return readFileSync(resolve(file), 'utf8');
      } catch (error) {
        throw new ConfigError(`cannot read the ${what} at ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    let url: URL;
    try {
      url = new URL(supUrl!);
    } catch {
      throw new ConfigError(`--supervisor is not a URL: ${supUrl}`);
    }
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new ConfigError('--supervisor must be https unless it is on this host');
    }
    supervisor = {
      url: url.toString(),
      callerId: supCaller!,
      privateKeyPem: read('supervisor caller key', supKey!),
      supervisorPublicKeyPem: read('supervisor public key', supPub!),
    };
  }

  return {
    envelope, envelopePath: path, command: rest[0], args: rest.slice(1), ledgerPath, filterToolList,
    ...(component ? { component } : {}),
    ...(supervisor ? { supervisor } : {}),
  };
}
