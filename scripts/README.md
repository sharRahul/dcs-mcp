# Project scripts

Files ending in `.mjs` are JavaScript source files run by Node.js. They belong in version control when they build, test or maintain the project. They are not generated mission files, and ordinary users do not need to open them.

Run these commands from the repository root. Mission generators and DCS-specific checks generally require `npm run build` first; some also need a DCS installation or Lua interpreter. See the [technical reference](../docs/technical-reference.md) for setup and limits.

| Source file | Purpose |
| --- | --- |
| `build-chatgpt-plugin.mjs` | Builds the local desktop plugin (`npm run plugin:build`). |
| `verify-chatgpt-plugin.mjs` | Tests the bundled plugin away from the checkout (`npm run plugin:verify`). |
| `run-tests.mjs` | Runs the test suite on Windows and other platforms (`npm test`). |
| `verify-npm-package.mjs` | Installs the built npm tarball into a temporary project and tests its CLI, resources and mission workflow (`npm run package:verify`). |
| `update-schema-fixture.mjs` | Updates the expected tool contracts after a deliberate API change. |
| `build-e2e-mission.mjs` | Generates the full example mission (`npm run build:e2e-mission`). |
| `build-verify-mission.mjs` | Generates a mission for checking features in DCS; documented in the verification record. |
| `iron-veil-airfields.mjs` | Shared airfield scenery helper, covered by `tests/iron-veil-airfields.test.ts`. |
| `verify-mission.mjs` | Checks a supplied mission file (`npm run verify:miz`). |
| `monitor-flight.mjs` | Collects simulator observations while flying (`npm run monitor`). |
| `generate-acceptance.mjs` | Generates repeatable acceptance missions (`npm run acceptance:generate`). |
| `collect-acceptance.mjs` | Collects evidence for acceptance checks (`npm run acceptance:collect`). |
| `verify-acceptance-lua.mjs` | Checks acceptance missions under Lua 5.1 (`npm run acceptance:lua51`). |
| `verify-capabilities.mjs` | Produces offline capability checks used by CI (`npm run verify:capabilities`). |
| `verify-design.mjs` | Produces offline mission-design checks used by CI (`npm run verify:design`). |
| `verify-lua51.mjs` | Checks Lua compatibility (`npm run verify:lua51`). |
| `verify-runtime-authoring.mjs` | Generates a live-check mission described in the authoring-coverage guide. |

Keep the source scripts and small test fixtures in GitHub. Generated builds, dependencies, mission archives, downloaded/generated audio and machine-specific verification runs stay local or belong in a release/CI artifact. Put local verification media and reports under `verification/`, which `.gitignore` excludes alongside builds, dependencies and mission archives. It deliberately does not ignore all `.mjs` files.
