# Agent credential exposed

A key in a prompt, a log, a trace, an approval file or a pushed repository. Microsoft
observed five minutes from a secret appearing on public GitHub to data leaving a key
vault. Plan for that clock, not for the day a secret-scanning ticket usually takes.

**Owner:** [name]. **Approver for re-issuing:** [name].

## First 5 minutes

1. **Revoke first, investigate second.** Deleting the file or the commit is not
   revocation; the value has already been read by anything that was watching. *Produces:*
   a revocation timestamp from the issuer.
2. **Revoke what it minted.** Sessions, short-lived tokens and downstream keys issued
   with the exposed credential do not die with it unless the issuer cascades. The PyPI
   briefing: the release was taken down in 31 minutes and the tokens it had already
   minted kept working. *Produces:* a list of derived credentials and their revocation.

## First hour

3. **Find every copy.** `red-team-harness audit-approvals` over every repository the
   agent's developers work in, for credentials saved into coding agent approval files.
   Then traces and logs: the Cursor briefing found unredacted credentials in a bucket of
   agent traces. *Produces:* the audit findings, with values never printed.
4. **Export what the credential reached** while it was exposed: `buildDisclosure` for
   the agent identity, from the earliest the value could have been seen. Anything the
   credential could reach that never crossed the boundary shows in coverage, if you
   measure it.
5. **Check the denials.** A burst of denials across services from one identity is
   someone mapping what the credential can do. It is the best telemetry you will get.

## Before closing

6. **Re-issue narrower.** Bound to a run (`credentials.bind`), with a lifetime no longer
   than the work (`max_lifetime_seconds`), for the data and window it needs.
7. **Run the drill on the new credential** and record the time. If revocation took
   longer than your budget during the incident, that is the finding to fix first.
