# Herdr Relay 0.2.0-rc.3

Date: 22 October 2026. Native-workflow prerelease for controlled evaluation.

RC3 adds GitHub Actions CI and downloadable GitHub Releases to the
[RC2 onboarding candidate](release-0.2.0-rc.2.md). Application behaviour and
credential boundaries are unchanged. RC2 artifacts remain historical and are
not overwritten.

## Downloads and Surface installation

Download these three assets from this release into the same private Linux-home
directory inside Surface's WSL2 distribution:

- `herdr-relay-0.2.0-rc.3.tgz`
- `SHA256SUMS`
- `herdr-relay-0.2.0-rc.3.tgz.verification.json`

This is an installable Node.js package containing the CLI and OpenCode plugins,
not a self-contained native binary. Require Linux Node.js 24+ and npm.

```bash
sha256sum -c SHA256SUMS
RELEASE="$HOME/.local/share/herdr-relay/releases/0.2.0-rc.3"
npm install --prefix "$RELEASE" ./herdr-relay-0.2.0-rc.3.tgz
RELAY="$RELEASE/node_modules/.bin/herdr-relay"
"$RELAY" native --help
```

Follow [installation and onboarding](installation-and-onboarding.md). Surface can
install this CLI and perform read-only Paperclip source/export/plan checks without
upgrading OpenCode, joining a node, clearing Evo or importing tasks. A clean Surface
will not pass full doctor until the backend upgrade and scoped node join are done.

## CI and publication gates

- Pushes and pull requests run syntax checks, serial root regression tests and v2 tests.
- A clean installed-package smoke verifies scoped onboarding, export/import retry,
  backup and service-unit generation. A fresh zero-finding production audit is required.
- A `vVERSION` tag must match both package manifests, lockfiles, Herdr metadata and notes.
- Tag releases rerun the complete CI workflow against that exact tag. A separate
  publication job uploads only its tested package, checksums and verification report.
- Prerelease versions are marked prerelease, not latest. Existing releases/assets
  are never overwritten. No npm publication or live deployment is performed.

## Readiness limits

This release does not certify physical Surface installation, provider authentication,
actual-human workflows or the real Paperclip export. Evo's existing backend/data
remain unchanged. Source backup/freeze, Evo-only data reconciliation, accepted-work
settlement and explicit archive/reset/import approval remain cutover gates.

GitHub Actions does not use private backend credentials or certify live Cloudflare
ingress. Read the verification report's exact source commit and audit outcome.
Checksums detect altered bytes but do not claim signing-key provenance.
