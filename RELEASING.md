# Releasing

The Python package publishes to PyPI through Trusted Publishing. No API token is
stored in this repository.

## One-time setup on PyPI

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

## Cutting a release

1. Set the version in `packages/python/pyproject.toml`.
2. Commit it on `main`.
3. Create a GitHub release with the tag `v<version>`, for example `v0.0.1`.

The release workflow builds the package, checks its metadata, verifies the tag matches
the version in `pyproject.toml`, and publishes. A mismatch fails the build before
anything reaches PyPI.

A version can never be reused on PyPI, even after deletion. `0.0.0` was the name
reservation, so the first functional release is `0.0.1`.
