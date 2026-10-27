# Security policy

## Reporting a vulnerability

Report security issues in this repository to **security@securedai.org**.

Our full vulnerability disclosure policy, including scope and what to expect, is at
https://securedai.org/disclosure and in machine-readable form at
https://securedai.org/.well-known/security.txt

Please do not open a public issue for a security report.

## Scope

This repository holds a specification, a JSON Schema and a validator. The most
security-relevant defects here are a schema that accepts an envelope it should reject,
or a validator that reports an unsafe envelope as valid. Both are in scope and both are
worth reporting.
