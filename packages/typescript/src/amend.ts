/**
 * Version 0.2: changing an envelope, and admitting a component into an agent's toolset.
 *
 * Changing an envelope. Specification section 2.1 requires that the agent an envelope
 * governs can never change it. 0.2 makes the alternative checkable: a new revision is
 * accepted only when it carries an Ed25519 signature from one of the approvers named in
 * the revision it replaces. Not the new one, or a change could name its own approver.
 * `checkAmendment` also lists every way the new revision widens the old, so the person
 * signing sees exactly what they are granting, and so a refused proposal can be recorded
 * with its reasons rather than vanishing.
 *
 * Admitting a component. An MCP server, a skill or a plugin declares in a manifest the
 * tools it brings and the hosts it reaches. `admitComponent` refuses it when either goes
 * beyond the envelope. The point is that a component cannot quietly join read access to
 * outbound reach: if it needs egress the envelope does not grant, it is refused at the
 * door, before any sentence in its description has been read by a model.
 */

import { createHash, createPublicKey, verify as edVerify, sign as edSign, createPrivateKey } from 'node:crypto';
import type { Envelope } from './evaluate.ts';
import { hostMatches, defaultDataMatcher } from './evaluate.ts';

/**
 * The bytes an amendment signature covers: the proposed envelope as canonical JSON.
 * Object keys sorted, no insignificant whitespace, and integer-valued numbers written
 * without a decimal point (2.0 is 2), so the Python implementation produces the same
 * bytes. Envelopes use ASCII keys, so code point and code unit order agree.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite numbers have no canonical form');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const added = (before: string[], after: string[]) => after.filter((x) => !before.includes(x));
const removed = (before: string[], after: string[]) => before.filter((x) => !after.includes(x));

/**
 * Every way `next` grants more than `current`. Empty means it narrows or changes
 * nothing that matters to authority. Lines are written for the person who signs.
 */
export function widening(current: Envelope, next: Envelope): string[] {
  const out: string[] = [];
  const cur = current as Record<string, any>;
  const nxt = next as Record<string, any>;

  const grants = (e: Record<string, any>) => new Map<string, Record<string, unknown>>(
    (e.tools?.allow ?? []).map((g: { name: string; constraints?: Record<string, unknown> }) => [g.name, g.constraints ?? {}]));
  const before = grants(cur), after = grants(nxt);
  for (const [name, constraints] of after) {
    if (!before.has(name)) { out.push(`tools.allow gains ${name}`); continue; }
    const was = before.get(name)!;
    for (const [k, v] of Object.entries(was)) {
      if (!(k in constraints)) out.push(`${name} loses its ${k} constraint`);
      else if (k.startsWith('max_') && Number(constraints[k]) > Number(v)) out.push(`${name} ${k} rises from ${v} to ${constraints[k]}`);
      else if (k.startsWith('min_') && Number(constraints[k]) < Number(v)) out.push(`${name} ${k} falls from ${v} to ${constraints[k]}`);
      else if (!k.startsWith('max_') && !k.startsWith('min_') && canonical(constraints[k]) !== canonical(v)) out.push(`${name} ${k} changes from ${canonical(v)} to ${canonical(constraints[k])}`);
    }
  }
  for (const t of removed(list(cur.tools?.deny), list(nxt.tools?.deny))) out.push(`tools.deny no longer refuses ${t}`);

  if (cur.data && !nxt.data) out.push('the data block is removed, leaving data unconstrained');
  for (const d of added(list(cur.data?.allow), list(nxt.data?.allow))) out.push(`data.allow gains ${d}`);
  if (cur.data?.allow && !nxt.data?.allow && nxt.data) out.push('data.allow is removed');
  for (const d of removed(list(cur.data?.deny), list(nxt.data?.deny))) out.push(`data.deny no longer refuses ${d}`);
  if (cur.data?.processors && !nxt.data?.processors) out.push('data.processors is removed, leaving processors unconstrained');
  for (const p of added(list(cur.data?.processors), list(nxt.data?.processors))) if (cur.data?.processors) out.push(`data.processors gains ${p}`);

  if (!cur.recipients && nxt.recipients) out.push('recipients are permitted where none were');
  for (const r of added(list(cur.recipients?.allow), list(nxt.recipients?.allow))) if (cur.recipients) out.push(`recipients.allow gains ${r}`);
  const perRun = (e: Record<string, any>) => e.recipients?.max_per_run;
  if (cur.recipients && perRun(cur) !== undefined && (perRun(nxt) === undefined || perRun(nxt) > perRun(cur))) {
    out.push(`recipients.max_per_run rises from ${perRun(cur)} to ${perRun(nxt) ?? 'unlimited'}`);
  }

  for (const [k, v] of Object.entries(cur.limits ?? {})) {
    const n = nxt.limits?.[k];
    if (n === undefined) out.push(`limits.${k} is removed`);
    else if (Number(n) > Number(v)) out.push(`limits.${k} rises from ${v} to ${n}`);
  }

  const rules = (e: Record<string, any>) => (e.escalate ?? []).map((r: unknown) => canonical(r));
  for (const r of removed(rules(cur), rules(nxt))) out.push(`an escalation is removed or changed: ${r}`);
  if (cur.on_no_response === 'deny' && nxt.on_no_response === 'allow') out.push('on_no_response changes from deny to allow');

  if (cur.expires && (!nxt.expires || Date.parse(nxt.expires) > Date.parse(cur.expires))) {
    out.push(`expires moves from ${cur.expires} to ${nxt.expires ?? 'never'}`);
  }

  if (cur.egress && !nxt.egress) out.push('the egress block is removed, leaving egress unconstrained');
  for (const h of added(list(cur.egress?.allow), list(nxt.egress?.allow))) if (cur.egress) out.push(`egress.allow gains ${h}`);
  if (cur.egress?.allow && nxt.egress && !nxt.egress.allow) out.push('egress.allow is removed');
  for (const h of removed(list(cur.egress?.deny), list(nxt.egress?.deny))) out.push(`egress.deny no longer refuses ${h}`);

  if (cur.credentials && !nxt.credentials) out.push('the credentials block is removed');
  if (cur.credentials?.bind === 'task' && nxt.credentials?.bind === 'run') out.push('credentials bind to the run rather than the task');
  const life = (e: Record<string, any>) => e.credentials?.max_lifetime_seconds;
  if (life(cur) !== undefined && nxt.credentials && (life(nxt) === undefined || life(nxt) > life(cur))) {
    out.push(`credentials.max_lifetime_seconds rises from ${life(cur)} to ${life(nxt) ?? 'unlimited'}`);
  }

  const approvers = (e: Record<string, any>) => (e.amendment?.approvers ?? []).map((a: { id: string; public_key: string }) => `${a.id} ${a.public_key.trim()}`);
  for (const a of added(approvers(cur), approvers(nxt))) out.push(`amendment.approvers gains ${a.split(' ')[0]}`);
  for (const t of removed(list(cur.amendment?.protected_tools), list(nxt.amendment?.protected_tools))) out.push(`amendment.protected_tools no longer protects ${t}`);
  if (cur.components?.require_manifest && !nxt.components?.require_manifest) out.push('components no longer need a manifest');

  return out;
}

export interface AmendmentCheck {
  accepted: boolean;
  /** Why it was refused. Empty when accepted. */
  reasons: string[];
  /** Every way the proposal widens the current revision, accepted or not. */
  widening: string[];
  /** Who signed it, when a signature verified. */
  approvedBy: string | null;
  /** For the ledger: refused proposals are recorded as carefully as accepted ones. */
  record(): AmendmentRecord;
}

export interface AmendmentRecord {
  kind: 'amendment';
  envelope_id: string;
  from_revision: number | null;
  to_revision: number | null;
  result: 'accepted' | 'rejected';
  reasons: string[];
  widening: string[];
  approved_by: string | null;
  proposal_digest: string;
  decided_at: string;
}

/** Sign a proposed revision, for the approver's own tooling. Returns base64url. */
export function signAmendment(proposed: Envelope, privateKeyPem: string): string {
  return edSign(null, Buffer.from(canonical(proposed)), createPrivateKey(privateKeyPem)).toString('base64url');
}

/**
 * Accept a new revision only with a valid signature from an approver named in the
 * revision it replaces. Never throws: every failure is a refusal with a reason.
 */
export function checkAmendment(
  current: Envelope,
  proposed: Envelope,
  signature: { approver: string; signature: string } | null,
  now: () => string = () => new Date().toISOString(),
): AmendmentCheck {
  const reasons: string[] = [];
  let widen: string[] = [];
  let approvedBy: string | null = null;
  let digest = '';
  try {
    widen = widening(current, proposed);
    digest = canonical(proposed);
  } catch (e) {
    reasons.push(`the proposal cannot be read: ${(e as Error).message}`);
  }
  if (proposed.id !== current.id) reasons.push(`the proposal is for ${proposed.id}, not ${current.id}`);
  const from = current.revision ?? 1, to = proposed.revision ?? 1;
  if (!(to > from)) reasons.push(`revision ${to} does not follow ${from}`);

  const approvers = current.amendment?.approvers ?? [];
  if (!approvers.length) {
    reasons.push('the current revision names no approvers, so it can only be changed through the policy repository\'s own review');
  } else if (!signature) {
    reasons.push('the proposal is not signed');
  } else {
    const who = approvers.find((a) => a.id === signature.approver);
    if (!who) reasons.push(`${signature.approver} is not an approver of the current revision`);
    else {
      let ok = false;
      try {
        const key = createPublicKey(who.public_key);
        ok = key.asymmetricKeyType === 'ed25519' && edVerify(null, Buffer.from(digest), key, Buffer.from(signature.signature, 'base64url'));
      } catch { ok = false; }
      if (ok) approvedBy = who.id;
      else reasons.push(`the signature does not verify against ${who.id}'s key`);
    }
  }
  const accepted = reasons.length === 0;
  const decidedAt = now();
  const proposalDigest = digest ? `sha256:${createHash('sha256').update(digest).digest('hex')}` : '';
  return {
    accepted, reasons, widening: widen, approvedBy: accepted ? approvedBy : null,
    record: () => ({
      kind: 'amendment', envelope_id: current.id,
      from_revision: current.revision ?? null, to_revision: proposed.revision ?? null,
      result: accepted ? 'accepted' : 'rejected', reasons, widening: widen,
      approved_by: accepted ? approvedBy : null, proposal_digest: proposalDigest, decided_at: decidedAt,
    }),
  };
}

/** What a component says it brings. Written by its publisher, checked here. */
export interface ComponentManifest {
  name: string;
  version?: string;
  /** Every tool the component exposes. */
  tools: string[];
  /** Every host it reaches. Absent or empty: none. */
  egress?: string[];
  /** Data it reads, in the deployment's addressing. */
  data?: string[];
  /** Processors it sends data to. */
  processors?: string[];
}

export interface Admission {
  admitted: boolean;
  reasons: string[];
}

/** Admit a component only when everything it declares is inside the envelope. */
export function admitComponent(envelope: Envelope, manifest: ComponentManifest): Admission {
  const reasons: string[] = [];
  if (!manifest || typeof manifest.name !== 'string' || !Array.isArray(manifest.tools)) {
    return { admitted: false, reasons: ['the manifest does not name the component and list its tools'] };
  }
  const granted = new Set((envelope.tools?.allow ?? []).map((g) => g.name));
  const denied = new Set([...(envelope.tools?.deny ?? []), ...(envelope.amendment?.protected_tools ?? [])]);
  for (const t of manifest.tools) {
    if (denied.has(t)) reasons.push(`${t} is refused by the envelope`);
    else if (!granted.has(t)) reasons.push(`${t} is not on tools.allow`);
  }
  for (const host of manifest.egress ?? []) {
    if (!envelope.egress) { reasons.push(`it reaches ${host}, and the envelope declares no egress, so outbound reach cannot be checked`); continue; }
    const d = (envelope.egress.deny ?? []).find((p) => hostMatches(host, p));
    if (d) reasons.push(`it reaches ${host}, which egress.deny refuses (${d})`);
    else if (envelope.egress.allow !== undefined && !envelope.egress.allow.some((p) => hostMatches(host, p))) reasons.push(`it reaches ${host}, which is not on egress.allow`);
  }
  for (const target of manifest.data ?? []) {
    if (!envelope.data) continue;
    if ((envelope.data.deny ?? []).some((p) => defaultDataMatcher(target, p))) reasons.push(`it reads ${target}, which data.deny refuses`);
    else if (envelope.data.allow !== undefined && !envelope.data.allow.some((p) => defaultDataMatcher(target, p))) reasons.push(`it reads ${target}, which is not within data.allow`);
  }
  if (envelope.data?.processors !== undefined) {
    for (const p of manifest.processors ?? []) if (!envelope.data.processors.includes(p)) reasons.push(`it sends data to ${p}, which is not on data.processors`);
  }
  return { admitted: reasons.length === 0, reasons };
}
