# Agent incident response runbooks

Response plans for an incident where an agent acted, not a person. In the IRONSCALES
survey of 501 security teams, 93 percent said their incident response plan covered AI
agents and 52 percent had formal controls for them. The gap is mostly here: plans that
assume a human typed the command, held the credential and can be interviewed about why.

Each runbook assumes the SecuredAI open tooling, and says what to use if you have
something else. Every step names what it produces, because a step that leaves no record
cannot be shown to have happened.

- [Agent acted outside its intent](acted-outside-intent.md): a suspected injection, a
  goal hijack, or an action nobody asked for.
- [Agent credential exposed](credential-exposed.md): a key in a prompt, a log, an
  approval file or a pushed repository.
- [Poisoned component](poisoned-component.md): an MCP server, skill or plugin carrying
  instructions or reaching somewhere it should not.
- [Disclosure under a deadline](disclosure.md): what to say first, and how not to have
  to take it back.

## Before you need them

1. **Know which agents exist and what each may do.** One envelope per agent, in a
   repository, with named approvers (`amendment.approvers`). If you cannot list them, the
   first hour of every runbook is spent finding out.
2. **Record refusals as well as successes.** The ledger, or any log that keeps denied
   calls. Arctic Wolf's intrusion showed as hundreds of denials before one success, and a
   log that files denials as noise throws away the warning.
3. **Know your revocation time.** Run `red-team-harness drill` against each agent
   credential in staging. If you do not know how long revocation takes, assume it is
   longer than the five minutes Microsoft saw between a leaked secret and data leaving.
4. **Measure coverage.** `measureCoverage` in the Agent Action Ledger, against the
   records of the systems your agents act on. Anything that went around the boundary is
   invisible to every runbook here.
5. **Name the people.** Each runbook has an owner and an approver. Write their names in,
   not a role or a mailbox.
