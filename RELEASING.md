# Releasing

One tag cuts both packages. `intent-envelope` on PyPI and `intent-envelope` on npm
carry the same version, because they implement the same specification and a version
skew between them is a question nobody should have to answer.

Neither registry holds an API token in this repository. Both publish through Trusted
Publishing over OIDC, so there is nothing here to leak or rotate.

| Package | Registry | Workflow | Environment | How it ships |
| --- | --- | --- | --- | --- |
| `packages/python` (`intent-envelope`) | PyPI | `release.yml` | `pypi` | Published once the environment reviewer approves the run |
| `packages/typescript` (`intent-envelope`) | npm | `release-npm.yml` | `npm` | Staged, then released by `npm stage approve` with 2FA |
| `packages/mcp-proxy` (`intent-envelope-mcp`) | npm | `release-npm.yml` | `npm` | Staged, then released by `npm stage approve` with 2FA |

The two npm packages are staged by the same workflow as separate matrix jobs and are
**approved separately**, so one can ship while the other is rejected.

The npm side cannot publish. `release-npm.yml` runs `npm stage publish`, which queues
a tarball the public cannot install, and a maintainer releases it by answering a 2FA
challenge. A compromised workflow, a stolen OIDC token or a bad merge can queue a
release but cannot ship one. The trusted publisher is configured stage-only, so a
plain `npm publish` from CI is rejected by the registry rather than merely discouraged.

The same argument this project makes about agents applies to its own pipeline: the
authority to act is granted narrowly and the irreversible step needs a human.

CI checks on every pull request that `pyproject.toml`, `__init__.py`,
`package.json` and `src/index.ts` all declare the same version. Finding that out from
a failed publish instead would mean a tag already exists for a version that cannot
ship.

## Cutting a release

1. Set the version in all six places. CI tells you if you miss one:
   - `packages/python/pyproject.toml`
   - `packages/python/src/intent_envelope/__init__.py`
   - `packages/typescript/package.json`
   - `packages/typescript/src/index.ts`
   - `packages/mcp-proxy/package.json`
   - `packages/mcp-proxy/src/index.ts`
2. Commit it on `main`.
3. Create a GitHub release with the tag `v<version>`, for example `v0.1.0`.

Both workflows run. Each builds its package, verifies the tag matches that package's
own version, runs the tests and the packaged-install check, and then waits on its
environment. A mismatch fails before anything reaches a registry.

4. PyPI publishes once you approve the `pypi` environment.
5. npm is staged, not published. Release it:

   ```sh
   npm stage list intent-envelope
   npm stage approve <the id that prints>

   npm stage list intent-envelope-mcp
   npm stage approve <the id that prints>
   ```

   Two packages, two approvals. The workflow prints both commands with the right
   package name when it finishes.

   That asks for a 2FA code. Before approving you can inspect exactly what would go
   out, which is the point of the gate rather than a formality:

   ```sh
   npm stage view <stage-id>
   npm stage download <stage-id>    # the actual tarball
   ```

   To abandon it instead, `npm stage reject <stage-id>`. A staged version occupies its
   version number while it sits in the queue, so a rejected 0.2.0 has to come back as
   0.2.1 rather than as another 0.2.0.

The stage subcommands need npm 11.15 or newer locally. A version can never be reused
on either registry, even after deletion.

## What the packaged-install check is for

Both packages have one: `packages/python/tools/consumer_smoke.py` and
`npm run smoke` in `packages/typescript`. Each builds the real artifacts, installs
them somewhere with no repository around it, and makes a real decision with the
installed copy.

They exist because of 0.0.1. That release went to PyPI carrying only the validator,
while the README documented an enforcement point, so `pip install intent-envelope`
followed by the README's own example raised ImportError. Every test passed, because
all of them imported from the source tree rather than from an installed copy. The
TypeScript package had the same class of defect waiting for it from the other
direction: Node refuses to strip types under `node_modules`, so pointing `exports` at
the `.ts` sources would have thrown on a consumer's first import.

A test suite that never installs the thing it tests cannot see either one.

## One-time setup on PyPI

Already done for this project. Recorded in case it needs redoing.

On https://pypi.org/manage/project/intent-envelope/settings/publishing/, add a
trusted publisher:

| Field | Value |
| --- | --- |
| Owner | `secured-ai` |
| Repository name | `intent-envelope` |
| Workflow name | `release.yml` |
| Environment name | `pypi` |

Then, in this repository's Settings, Environments, create an environment named
`pypi`. Adding yourself as a required reviewer means every publish waits for a human
click, which is worth it for a package other people will install.

## Why `intent-envelope-mcp` does not pin `intent-envelope` exactly

`packages/mcp-proxy` depends on `intent-envelope` as `>=0.1.0 <1.0.0` rather than
`^0.2.0`. A caret range naming the version being released does not exist on the
registry until that release finishes, so `npm ci` on the pull request that performs the
bump would fail resolving a dependency that pull request is itself creating.

The range is safe to state because the two are released together from this repository
and tested against each other on every CI run, not because 0.x minors are generally
compatible. If they ever stop being released together, tighten it.

## One-time setup on npm

Done for `intent-envelope`. **Not yet done for `intent-envelope-mcp`**, which is still
an unclaimed name.

npm requires a package to exist before a trusted publisher can be configured for it, so
a brand new name cannot start with OIDC. The first publish of each name is manual, and
after that nothing is. `intent-envelope@0.0.0` was published by hand on 2 November 2026
for exactly that reason, and is a name reservation and nothing more, the same role
`0.0.0` served on PyPI.

### Claiming a new name

```sh
cd packages/mcp-proxy
npm login
npm ci && npm test && npm run smoke
npm version 0.0.0 --no-git-tag-version
npm publish --dry-run          # check dist/ and the file list before it is real
npm publish --access public
git checkout package.json      # put the version back
```

A publish can take a few minutes to settle. `npm view <name> version` may report a
placeholder in the meantime, which does not mean anything is waiting for approval.

### Configuring the trusted publisher

On npmjs.com, **Packages → the package → Settings → Trusted publishing**, choose
GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `secured-ai` |
| Repository | `intent-envelope` |
| Workflow filename | `release-npm.yml` |
| Environment name | `npm` |

Both packages use the same workflow filename, so both configurations name
`release-npm.yml`.

What remains for `intent-envelope-mcp`:

1. Claim the name and configure the trusted publisher, as above.
2. Under allowed actions, leave `npm publish` **off**. `npm stage publish` is always
   permitted and is all this workflow uses. Leaving `npm publish` off is what makes
   stage-only an enforced property rather than a convention: the registry rejects a
   direct publish from CI even if the workflow is changed to attempt one.
3. Turn on the option requiring OIDC, which disables token publishing for this
   package entirely. This is the step that makes the rest of it mean anything, and it
   is the easy one to skip.
4. `npm logout` on any machine where you published manually, so the session token
   that claimed the name stops working.
5. In this repository's Settings, Environments, create an environment named `npm`.

### Why the npm environment has no required reviewer

`pypi` has one because it is the only human gate on that side: PyPI publishes the
moment the run is approved. On npm the gate is `npm stage approve` with 2FA, which
happens after the workflow has finished and inspects the actual artifact rather than
the intention to build one. Requiring a reviewer as well would mean two approvals per
release for one decision, and the second click would be the weaker of the two.

The environment is still declared, because the trusted publisher configuration is
scoped to it. That restricts which workflow runs can obtain an OIDC token at all.

Add a reviewer if you would rather gate token issuance too. It is a real defence, just
a redundant one here.

### Two npm quirks

npm does not validate a trusted publisher configuration when you save it, so a typo
surfaces only at the next release. And a new configuration expires if it has not
completed a successful publish within two days, so do this when you are ready to tag
rather than well ahead of it.

### Provenance

`release-npm.yml` passes `--provenance` explicitly. npm generates an attestation
automatically when staging this way from a public repository, so the flag is
belt-and-braces: a release that silently lost its attestation would be worse than one
that failed to stage. Provenance is what lets anyone verify the tarball on npm was
built from a specific commit in this repository. For a package whose job is to enforce
what an agent may do, being able to prove the published artifact came from reviewed
source is worth more than usual.

Note that `0.0.0` has no provenance, because it was published by hand. Every version
from 0.1.0 onwards does.

## The schema is stored twice, on purpose

`schema/intent-envelope-0.1.json` is canonical. A byte-identical copy lives at
`packages/python/src/intent_envelope/schema/` so the Python package carries its own
schema and does not reach outside its own directory at build time, which an sdist
cannot do. The TypeScript package inlines the same schema as a module at
`packages/typescript/src/schema.ts`, regenerated with `npm run gen:schema`.

CI fails if any copy drifts from the canonical one, so change the canonical file and
regenerate or copy the others in the same commit.
