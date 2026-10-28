# Release procedure

Release preparation does not publish, upgrade services, change live configuration
or reset state. Publication requires an explicit human instruction and an immutable
version tag. Packages are distributed through GitHub Releases, not npm.

## Required gates

1. Review the intended native product scope and compatibility contract.
2. Keep root/plugin versions, both lockfiles, Herdr metadata and versioned notes
   consistent. Run `node scripts/check-release.mjs`.
3. Run `npm run check`, serial root regression tests and plugin tests.
4. Run relevant isolated native model/PTY, contract, reporting, Herdr and compatible
   upgrade checks. Keep logs outside the checkout or as CI artifacts.
5. Commit reviewed source and notes; require a clean source tree.
6. Verify a production-only installation, exact supported OpenCode 2.1.0/2.1.2
   hosts and a fresh zero-vulnerability production audit. An unavailable audit is
   not a passed audit. Supplemental host checks do not replace this matrix.

The RC4 baseline fixture tests compatible upgrades and rollback. It is not shipped
or certification of physical second-machine/business-source coverage.

## Package verification

From clean committed source, use a new versioned output directory outside the
checkout. Configure the exact host binaries required by release verification:

```sh
RELAY_V2_BINARY=/absolute/opencode-2.1.2 \
RELAY_V2_BASELINE_BINARY=/absolute/opencode-2.1.0 \
node scripts/verify-package.mjs --release --output /private/artifacts/0.2.1
```

Assets are `herdr-relay-0.2.1.tgz`, `SHA256SUMS` and
`herdr-relay-0.2.1.tgz.verification.json`. The report records the source commit,
cleanliness, timestamp, host checks and audit result. Different bytes at an
existing artifact path or inconsistent checksums are refused.

The verifier exercises native backend startup, scoped two-home onboarding,
idempotent native capture, agent messaging, plugin/skill setup, backup and unit
generation. It rejects retired code and private/development files in the package.
`--skip-audit` is offline preflight only and is refused with `--release`.
Checksums establish byte integrity, not a signing-key attestation.

## Push, CI, tag, publish

On an explicit publication request:

1. Push the exact release commit and wait for branch CI to pass.
2. Create an annotated tag at that verified commit, not a moving branch.
3. Push the tag; the release workflow verifies the exact tag again.
4. After publication, download the assets and verify their checksums, source commit,
   clean-source provenance, supported-host checks and zero-finding audit.

```sh
git tag -a v0.2.1 EXACT_VERIFIED_COMMIT -m "Herdr Relay 0.2.1"
git push origin refs/tags/v0.2.1
```

`.github/workflows/ci.yml` runs tests/package verification on branch pushes, pull
requests and reusable workflow calls. `.github/workflows/release.yml` runs on
version tags and publishes only after all gates pass. CI has read-only repository
permissions; only the final publication job gets `contents: write`.

The release job takes `docs/release-VERSION.md`, checks tag/version/source evidence
and publishes all three assets. Candidate versions are prereleases; stable 0.2.1
has no prerelease suffix. Stable releases become the latest release. Prereleases
use `--prerelease --latest=false` and do not replace the stable selection.

Existing releases/assets are never replaced. Do not retarget published tags,
force-push release history or reuse a published version for different bytes. A
correction after publication needs a new version. Historical notes/source remain
available at their original tags even when removed from the current tree.

## Deployment remains separate

Publication does not authorise a service upgrade, shortcut install, credential
change or recovery. Use [installation](installation-and-onboarding.md) for a new
host and [upgrades](service-upgrades.md) for existing hosts. Preserve runtime state
and unrelated preferences. Never delete a journal to make a release appear clean.
