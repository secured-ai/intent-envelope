# Releasing

One tag cuts both packages. `intent-envelope` on PyPI and `intent-envelope` on npm
carry the same version, because they implement the same specification and a version
skew between them is a question nobody should have to answer.

Neither registry holds an API token in this repository. Both publish through Trusted
Publishing over OIDC, so there is nothing here to leak or rotate.

| Package | Registry | Workflow | Environment |
| --- | --- | --- | --- |
| `packages/python` | PyPI | `release.yml` | `pypi` |
| `packages/typescript` | npm | `release-npm.yml` | `npm` |

CI checks on every pull request that `pyproject.toml`, `__init__.py`,
`package.json` and `src/index.ts` all declare the same version. Finding that out from
a failed publish instead would mean a tag already exists for a version that cannot
ship.

## Cutting a release

1. Set the version in all four places. CI tells you if you miss one:
   - `packages/python/pyproject.toml`
   - `packages/python/src/intent_envelope/__init__.py`
   - `packages/typescript/package.json`
   - `packages/typescript/src/index.ts`
2. Commit it on `main`.
3. Create a GitHub release with the tag `v<version>`, for example `v0.1.0`.

Both workflows run. Each builds its package, verifies the tag matches that package's
own version, runs the tests and the packaged-install check, and then waits on its
environment before publishing. A mismatch fails before anything reaches a registry.

A version can never be reused on either registry, even after deletion.

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

## One-time setup on npm

Not yet done. npm requires a package to exist before a trusted publisher can be
configured for it, so a brand new name cannot start this way. The first publish is
manual, and after that nothing is manual again.

1. Create an npm granular access token with publish rights, scoped to this package.
2. Publish once from your own machine, which also claims the name:

   ```sh
   cd packages/typescript
   npm ci && npm test && npm run smoke
   npm publish --access public
   ```

3. On https://www.npmjs.com/package/intent-envelope/access, open the Trusted
   Publisher section and choose GitHub Actions:

   | Field | Value |
   | --- | --- |
   | Organization or user | `secured-ai` |
   | Repository | `intent-envelope` |
   | Workflow filename | `release-npm.yml` |
   | Environment name | `npm` |

4. Turn on the option requiring OIDC, which disables token publishing for this
   package. This is the step that makes the rest of it mean anything, and it is easy
   to skip.
5. Delete the token from step 1.
6. In this repository's Settings, Environments, create an environment named `npm`,
   with yourself as a required reviewer.

Two things worth knowing. npm does not validate a trusted publisher configuration
when you save it, so a typo surfaces only at the next publish. And a new
configuration expires if it does not complete a successful publish within two days,
so do the setup when you are ready to cut a release rather than well ahead of it.

### Provenance

npm generates a provenance attestation automatically when publishing this way from a
public repository, which is why `release-npm.yml` passes no `--provenance` flag. It
lets anyone verify the tarball on npm was built from a specific commit in this
repository. For a package whose job is to enforce what an agent may do, being able to
prove the published artifact came from reviewed source is worth more than usual.

## The schema is stored twice, on purpose

`schema/intent-envelope-0.1.json` is canonical. A byte-identical copy lives at
`packages/python/src/intent_envelope/schema/` so the Python package carries its own
schema and does not reach outside its own directory at build time, which an sdist
cannot do. The TypeScript package inlines the same schema as a module at
`packages/typescript/src/schema.ts`, regenerated with `npm run gen:schema`.

CI fails if any copy drifts from the canonical one, so change the canonical file and
regenerate or copy the others in the same commit.
