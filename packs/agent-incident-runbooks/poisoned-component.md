# Poisoned component

An MCP server, skill or plugin carrying instructions in its descriptions, or reaching a
host it should not. In OX Security's research, 22 percent of flagged MCP servers carried
prompt injection or tool poisoning, and 44 percent of flagged skills told agents to send
data out. The payload is a sentence, and no scanner looking for code that runs will find
it.

**Owner:** [name].

## First 15 minutes

1. **Remove it from every envelope's toolset.** If the deployment requires manifests
   (`components.require_manifest`), withdraw its manifest and the proxy refuses to start
   it. *Produces:* a configuration change with a timestamp.
2. **Block its hosts in egress.deny** across envelopes, by signed amendment, until you
   know what it reached.

## First hour

3. **Compare what it declared with what it did.** Its manifest's tools and egress
   against the ledger: calls to tools it never declared are refused with rule
   `components`, and those refusals say when it started.
4. **Export what the agents that loaded it reached,** from when it was installed. The
   instruction could only work through permissions those agents already held, so the
   disclosure is about the agents, not the component.

## Before closing

5. **Admit components only by manifest from now on,** and review a component's
   descriptions as code, because they are read by a model as instructions.
