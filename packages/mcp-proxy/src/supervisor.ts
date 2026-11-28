/**
 * Escalations that wait for a person, through a Supervisor Check service.
 *
 * This proxy decides calls on its own, against the envelope, in process. What it cannot
 * do on its own is reach a person and hold a call while they decide. The supervisor can:
 * it derives the facts of the call from systems of record, opens an approval for the
 * person the envelope names, and returns a signed answer bound to the exact request.
 *
 * So an escalation here is sent to the supervisor's /check, and the call goes through
 * only on a record signed by the supervisor key pinned in this process, for this request,
 * that says allow. The supervisor's own evaluation can also deny outright, on facts this
 * proxy could not see. It cannot turn a call this proxy refused into an allow, because a
 * refused call never gets this far.
 *
 * supervisor-check is loaded only when --supervisor is given, so the proxy keeps its one
 * dependency for everyone else.
 */

import type { Decision } from 'intent-envelope';
import { ConfigError } from './config.ts';
import type { EscalationAnswer, EscalationHandler } from './relay.ts';

export interface SupervisorSettings {
  url: string;
  callerId: string;
  /** Ed25519 private key, PKCS8 PEM: this host's key, registered with the supervisor. */
  privateKeyPem: string;
  /** The supervisor's ES256 public key, SPKI PEM. Pinned here, never fetched. */
  supervisorPublicKeyPem: string;
}

interface ClientDecision {
  outcome: 'allow' | 'deny' | 'escalate';
  reason: string;
  verified: boolean;
  approval_id?: string;
  record?: { approval?: { decided_by?: string } };
}
interface Client {
  checkAndWait(request: unknown, wait: { signal: AbortSignal }): Promise<ClientDecision>;
}

export async function supervisorEscalations(settings: SupervisorSettings): Promise<EscalationHandler> {
  // A variable, so neither TypeScript nor a bundler insists on the package being there.
  const name = 'supervisor-check';
  let mod: { SupervisorClient: new (opts: SupervisorSettings) => Client };
  try {
    mod = (await import(name)) as typeof mod;
  } catch {
    throw new ConfigError('--supervisor needs supervisor-check 0.3 or newer installed beside this proxy: npm install -g supervisor-check');
  }
  if (typeof (mod.SupervisorClient?.prototype as Partial<Client> | undefined)?.checkAndWait !== 'function') {
    throw new ConfigError('the installed supervisor-check cannot wait for approvals: 0.3 or newer is needed');
  }
  const client = new mod.SupervisorClient(settings);

  return {
    describe: () => `the supervisor at ${settings.url}, as ${settings.callerId}`,
    async resolve(call, decision: Decision, signal): Promise<EscalationAnswer> {
      const principal = decision.envelope.principal;
      const answer = await client.checkAndWait(
        {
          envelope_id: decision.envelope.id,
          ...(principal?.agent_identity ? { agent_identity: principal.agent_identity } : {}),
          ...(principal?.on_behalf_of ? { principal: principal.on_behalf_of } : {}),
          call: { tool: call.tool, arguments: call.arguments },
        },
        { signal },
      );
      if (answer.outcome === 'escalate') {
        return { outcome: 'deny', verified: false, reason: 'the supervisor escalated but holds no approval channel, so nobody can answer it' };
      }
      return {
        outcome: answer.outcome,
        verified: answer.verified,
        reason: answer.reason,
        ...(answer.approval_id ? { approval_id: answer.approval_id } : {}),
        ...(answer.record?.approval?.decided_by ? { decided_by: answer.record.approval.decided_by } : {}),
      };
    },
  };
}
