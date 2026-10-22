# Candidate packaging and prerelease procedure

Release preparation does not clear state, install services, upgrade a laptop,
publish npm packages or create tags. An explicitly pushed version tag runs CI
and publishes a GitHub release only after verification succeeds.

## GitHub automation

- `.github/workflows/ci.yml` runs on branch pushes and pull requests. It requires
  Node.js 24 on Ubuntu, syntax checks, serial root regression tests, v2 tests,
  clean installed-package/onboarding verification and a zero-finding fresh audit.
- Successful runs retain a `release-assets` Actions artifact for 30 days. Releases
  provide persistent downloads without requiring an Actions-artifact download.
- `.github/workflows/release.yml` runs on `v[0-9]*` tag pushes, calls the same CI
  workflow at the tagged commit and publishes only after all jobs succeed.
- Versioned manifests, lockfiles, Herdr metadata, notes and tag must agree.
- CI/build jobs have read-only repository access. Only the publication job gets
  `contents: write`, consumes verified artifacts and uses `GITHUB_TOKEN`.
- Actions are pinned to commit hashes. No private deployment credentials, model
  provider keys or live backend access are required. Synthetic real-TUI, physical
  Surface and live-ingress checks remain separate evidence, not implied CI coverage.
- Existing releases/assets are refused, not replaced. Failed runs can be rerun
  before publication. Once published, fixes require a new version and tag.

No manual workflow button or default-branch change is required. `v2` may remain
separate from the repository's current default branch. Tagging is the explicit
publication action, not a deployment action.

## 1. Freeze a candidate

1. Agree its native-workflow scope and remaining acceptance gates.
2. Update the root/plugin package versions, both lockfiles and Herdr manifest.
3. Run syntax checks, serial root tests, v2 tests and scoped real-TUI probes.
4. Review migration/onboarding commands and secret/configuration handling.
5. Commit the reviewed source and release notes. Require a clean tree.

Do not reuse a published candidate version for changed bytes. RC2 supersedes
RC1's checkout-oriented onboarding; the prior candidate and its evidence remain
historical records rather than being silently overwritten.

## 2. Build and verify the installed artifact

From the clean committed source, use a **new versioned output directory outside
the checkout**:

```bash
node scripts/verify-package.mjs --release --output /absolute/artifacts/0.2.0-rc.3
```

This verifies a production-only npm installation, executable CLI, plugin imports,
native backend startup, scoped Evo/Surface-home onboarding, export/import retry,
backup and unit generation. It requires a successful fresh production audit with
zero findings. The report records the source commit and verification timestamp.
It refuses different bytes at an existing artifact path or mismatched checksums.

Assets:

- `herdr-relay-0.2.0-rc.3.tgz`
- `SHA256SUMS`
- `herdr-relay-0.2.0-rc.3.tgz.verification.json`

`--skip-audit` is allowed for clearly marked offline **preflight** only. It is
refused with `--release`; an unavailable audit is not a passed audit. Clean-home
fixtures never replace physical Surface or real Paperclip-data acceptance.

Verify the checksum again after transfer. Checksums are integrity checks, not
signatures. No signing-key provenance is claimed by an unsigned candidate.

## 3. Publish only after explicit approval

Channel: a GitHub **prerelease** for candidate versions, not npm. The package remains
private for npm publication. Confirm the report's source commit, zero findings,
scope/limitations and intended asset bytes before approval.

Commit/push reviewed source, let branch CI pass, then create an annotated version
tag pointing to the exact reviewed commit and push it:

```bash
git tag -a v0.2.0-rc.3 EXACT_SOURCE_COMMIT -m "Herdr Relay 0.2.0-rc.3"
git push origin refs/tags/v0.2.0-rc.3
```

The release workflow reruns tests and builds its own artifact at that tag. It uses
`docs/release-0.2.0-rc.3.md` for notes, verifies source provenance and checksums,
then creates the release with all three assets. It marks candidate versions as
prerelease and never promotes them to latest. Do not tag a moving branch or upload
artifacts from another checkout/commit.

Do not overwrite assets, retarget tags, force-push release history or equate an RC
with full v3 certification. If a correction changes bytes, increment the RC and
repeat verification. No publication/tag command is run by the verifier.

## 4. Keep installation separate from data cutover

Follow [installation and onboarding](installation-and-onboarding.md). Surface can
install the CLI and perform a read-only Paperclip export before changing OpenCode
or Evo. Backend reset/archive, node joining, plugin context replacement and task
import each have their own checks and approvals. Publishing a candidate authorises
none of those implicitly.
