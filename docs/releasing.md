# Candidate packaging and prerelease procedure

Release preparation does not clear state, install services, upgrade a laptop,
publish npm packages or create tags. Those are separate explicit actions.

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
node scripts/verify-package.mjs --release --output /absolute/artifacts/0.2.0-rc.2
```

This verifies a production-only npm installation, executable CLI, plugin imports,
native backend startup, scoped Evo/Surface-home onboarding, export/import retry,
backup and unit generation. It requires a successful fresh production audit with
zero findings. The report records the source commit and verification timestamp.
It refuses different bytes at an existing artifact path or mismatched checksums.

Assets:

- `herdr-relay-0.2.0-rc.2.tgz`
- `SHA256SUMS`
- `herdr-relay-0.2.0-rc.2.tgz.verification.json`

`--skip-audit` is allowed for clearly marked offline **preflight** only. It is
refused with `--release`; an unavailable audit is not a passed audit. Clean-home
fixtures never replace physical Surface or real Paperclip-data acceptance.

Verify the checksum again after transfer. Checksums are integrity checks, not
signatures. No signing-key provenance is claimed by an unsigned candidate.

## 3. Publish only after explicit approval

Recommended channel: a GitHub **prerelease**, not npm yet. The package remains
private for npm publication. Confirm the report's source commit, zero findings,
scope/limitations and intended asset bytes before approval.

The explicit publishing operation should create an annotated version tag pointing
to the report's exact commit, push that tag, then create a prerelease which verifies
that existing tag and uploads all three assets. Use `docs/release-0.2.0-rc.2.md`
for the notes and link the primary onboarding guide at that tag. Do not tag a moving
branch or upload artifacts from another checkout/commit.

Do not overwrite assets, retarget tags, force-push release history or equate an RC
with full v3 certification. If a correction changes bytes, increment the RC and
repeat verification. No publication/tag command is run by the verifier.

## 4. Keep installation separate from data cutover

Follow [installation and onboarding](installation-and-onboarding.md). Surface can
install the CLI and perform a read-only Paperclip export before changing OpenCode
or Evo. Backend reset/archive, node joining, plugin context replacement and task
import each have their own checks and approvals. Publishing a candidate authorises
none of those implicitly.
