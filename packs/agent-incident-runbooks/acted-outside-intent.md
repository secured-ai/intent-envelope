# Agent acted outside its intent

A suspected prompt injection, a goal hijack, or an action nobody asked for. The agent
did something, or tried to, that its owners did not intend.

**Owner:** [name]. **Approver for narrowing the envelope:** [name].

## First 15 minutes: stop it doing more

1. **Narrow the envelope, do not delete the agent.** Remove the tool or recipient that
   was misused, as a signed amendment if the envelope names approvers. Deleting the agent
   destroys the state you need; narrowing stops the action and keeps the evidence.
   *Produces:* an amendment record with the widening list empty and the narrowing in the
   diff.
2. **Withdraw pending approvals.** Anything escalated by this agent and still waiting for
   a person should be refused, not left for someone to approve in good faith.
   *Produces:* approval records ending `withdrawn` or `denied`.
3. **Revoke the agent's current credentials.** Not the role, the credentials the run
   holds. With `credentials.bind` set, a credential from this run is useless to the next
   one anyway; without it, assume it is still live. *Produces:* revocation timestamps.

## First hour: establish what happened

4. **Export what the agent reached.** `buildDisclosure` for the agent identity, from
   before the first suspicious call to now. Read the second half first: what is not yet
   established. *Produces:* a signed disclosure.
5. **Find the input that carried the instruction.** Documents, tickets, tool results or
   emails the agent read just before the first off-intent call. Keep them unmodified;
   they are the injection.
6. **Check what the agent said it was doing.** The contradiction report lists calls
   where the agent's account of its action did not match the systems of record. If it
   misreported, every log that recorded its own description is unreliable for this
   incident.

## Before closing

7. **Write the envelope change that would have stopped it,** and the decision case that
   proves it: the call, the state, the expected `deny` and rule. Add it to your own
   conformance cases so it stays fixed.
8. **Run the reach probes** (`red-team-harness probe --only reach/...`) against the
   narrowed envelope before restoring anything.
