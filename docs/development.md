# Development and verification

## Local checks

```sh
npm ci
npm ci --prefix packages/opencode-relay
npm run check
npm test
npm run test:v2
node scripts/check-release.mjs
```

`npm run check` validates generated TUI files, JavaScript syntax, local source
imports, documentation links and the native-only repository boundary. Old provider
services, development journals and captured evaluation output must not return to
the package through a documentation edit or a forgotten import.

`npm run build:tui` compiles the Solid entrypoint and sidebar. The generated ESM
files are committed. OpenCode's installed-package renderer must be tested separately
from checkout imports; a successful plain Node.js import does not prove rendering.

## Isolated integration checks

```sh
node scripts/verify-cli-bridge.mjs
node scripts/verify-headless-setup.mjs --legacy-contract-refusal --capabilities
node scripts/verify-headless-setup.mjs --connection-rebind --contract-update --capabilities
node scripts/verify-headless-setup.mjs --run-result-notifications --capabilities --shell
node scripts/verify-herdr-panel.mjs
node scripts/verify-upgrade.mjs --active-work
node scripts/verify-package.mjs
```

These use explicit disposable state, fixture model/MCP responses and isolated
HOME/XDG directories. The Herdr check creates and stops its own named test server.
Do not redirect them to a user's live state. PTY checks require Python and POSIX.

`RELAY_PACKAGE_DIRECTORY` selects an already installed package for supported
verifiers. `verify-installed-tui.mjs --package DIRECTORY --binary OPENCODE_BINARY`
checks the actual host renderer. Release verification requires the exact supported
OpenCode host binaries and a fresh production audit.

Logs and verification receipts belong in CI artifacts or a private scratch path,
normally `/tmp/opencode`, not `docs/evidence` or a development ledger in Git.
The package and upgrade verifiers accept `RELAY_TEST_SCRATCH=/private/scratch`
when dependency-heavy fixtures exceed a temporary filesystem's inode capacity.
Never commit credential files, private task exports, runtime databases or model
conversation captures. Old records remain available in tagged history.

## Coverage and release integrity

Retain native identity, permission, review, recovery, offline-cache and compatible
upgrade regressions when removing obsolete integration tests. Shared native code
must not depend on a retired service merely to obtain a test fixture.

Tests prove their stated fixture contracts, not complete real-world source
coverage, physical multi-machine qualification or external-message delivery.
Published source, tags and assets are immutable. See [releasing](releasing.md).
