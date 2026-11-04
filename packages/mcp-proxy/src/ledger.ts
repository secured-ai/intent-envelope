/**
 * Every decision, appended as it is made.
 *
 * Refusals are recorded, not only successes. A log holding what succeeded cannot answer
 * the question an incident asks, which is what the agent tried to do.
 *
 * One JSON object per line, append only, flushed per decision. A ledger that buffers
 * loses exactly the records an operator wants when a process is killed mid-run, and the
 * run where that happens is the interesting one.
 */

import { appendFileSync } from 'node:fs';
import type { Decision, DecisionRecord } from 'intent-envelope';

export interface Ledger {
  record(decision: Decision): void;
  entries(): DecisionRecord[];
}

/** Keeps decisions in memory only. Used by the tests and when no path is configured. */
export function memoryLedger(): Ledger {
  const held: DecisionRecord[] = [];
  return {
    record: (decision) => {
      held.push(decision.record());
    },
    entries: () => held.slice(),
  };
}

/**
 * Appends to a file as well as keeping them in memory.
 *
 * A failed write must not take the enforcement point down with it: refusing calls
 * correctly while unable to log is a degraded state, but silently allowing them because
 * a disk filled up is a breach. So a write failure is reported once, to stderr, and
 * enforcement carries on.
 */
export function fileLedger(path: string, onError?: (message: string) => void): Ledger {
  const memory = memoryLedger();
  let warned = false;

  return {
    record: (decision) => {
      memory.record(decision);
      try {
        appendFileSync(path, `${JSON.stringify(decision.record())}\n`, 'utf8');
      } catch (error) {
        if (!warned) {
          warned = true;
          const reason = error instanceof Error ? error.message : String(error);
          (onError ?? ((m: string) => process.stderr.write(`${m}\n`)))(
            `[intent-envelope] cannot write the ledger to ${path}: ${reason}. ` +
              'Enforcement continues; decisions are kept in memory only.',
          );
        }
      }
    },
    entries: () => memory.entries(),
  };
}
