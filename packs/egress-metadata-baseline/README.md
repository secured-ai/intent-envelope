# Egress and metadata baseline

A starting point for any agent that has a tool able to reach the network: a fetch tool,
a browser, an HTTP client, an MCP server that calls an API. Intent Envelope 0.2.

Three briefings asked for it:

- **One prompt, every agent in the account** (Bedrock AgentCore). Someone asked a
  public agent to fetch a URL, and the URL was the instance metadata service. The
  credentials it returned belonged to a default role that reached every agent in the
  account.
- **Containment is a network property** (Trajectory Labs). Instructions, a DNS redirect
  and an IP block all gave way. What held was a sandbox with no route out.
- **The payload is a sentence** (OX Security). A sentence in a skill asked the agent to
  send data out, and worked because read access and outbound reach were held together.

## What is in it

`egress.json` is an `egress.deny` list to merge into any 0.2 envelope:

| Entries | Why |
| --- | --- |
| `169.254.0.0/16`, `fd00:ec2::254` | Link-local, including the AWS, GCP and Azure instance metadata address `169.254.169.254`, the ECS task metadata endpoint, and the AWS IPv6 metadata address |
| `metadata.google.internal`, `metadata.goog`, `metadata.azure.com`, `168.63.129.16`, `100.100.100.200` | Metadata and platform endpoints by name: GCP, Azure (including the wire server) and Alibaba Cloud |
| `127.0.0.0/8`, `localhost`, `0.0.0.0/8` | The host the agent runs on |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` | Private and carrier-grade NAT ranges: your internal network |
| `.internal`, `.local`, `.svc.cluster.local`, `kubernetes.default.svc` | Internal names, including the Kubernetes API from inside a pod |

Deny is checked before allow, so these hold even if someone later widens `egress.allow`
to a broad pattern. Widening `egress.deny` back out needs a signed amendment if the
envelope names approvers, and the widening list will say so.

`example-envelope.json` is a complete 0.2 envelope using it: a support agent that may
fetch two hosts and nothing else, with credentials bound to the run and a component
manifest required.

## What it cannot do on its own

- **It is enforced on the hosts an enforcement point established.** Section 2.1 of the
  specification: resolve the destination yourself, after redirects, rather than reading
  the host the agent put in its arguments. A redirect from an allowed host to
  `169.254.169.254` is the classic way around a list that checks only the first URL.
- **IPv6 ranges are not patterns yet.** 0.2 host patterns take exact IPv6 addresses only.
  If your network routes IPv6 to internal services, block it at the network layer too.
- **It is not a sandbox.** Trajectory's result is that the control that held was a route
  that did not exist. Use this list inside an egress proxy or a network policy that
  enforces it for every process, not only for the tools the envelope knows about.

## One role per agent

The AgentCore finding was not only the fetch. It was that the credentials it returned
belonged to a default role shared by every agent in the account, so one prompt reached
all of them. Give each agent its own role, scoped to what its envelope grants, and set
`credentials.bind` so a credential from one run cannot be used in another. This pack's
example sets both.
