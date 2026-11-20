# Security acceptance — v0.6.4

## Scope

Acceptance covers the local stdio server, optional loopback DCS bridge,
mission-file handling, locked dependencies and GitHub release process. It is a
scoped source/test review, not an external penetration-test certificate. The exact
accepted source and workflow URLs are attached as `release-acceptance.json`.

## Dependency findings resolved

The pre-release audit found vulnerabilities in development-only MCPB CLI
dependencies: old Zod and the `external-editor`/`tmp` chain. Production dependencies
were clean. The CLI was removed. Ajv now validates manifests against the unmodified,
hash-pinned upstream MCPB 0.4 schema; its MIT licence is retained in `vendor/mcpb/`.

CI and package builds run `npm audit --audit-level=low` on the full locked tree.
Release preparation repeats the audit and requires **zero** reported vulnerabilities.
Audits are time-sensitive and do not inspect vendored Lua or detect every flaw.

The source review also found two release blockers, now covered by regressions:
builders could recursively copy ignored local files, and Lua `__proto__` keys
could spoof an individual parsed table's prototype and disappear during saves.
All three builders now stage only versioned package sources and a fresh `dist`.
Lua literal keys are created as own data properties without invoking prototype
setters. No global prototype pollution or code execution was demonstrated.

## Controls and evidence

| Boundary | Control | Evidence |
| --- | --- | --- |
| Mission Lua | Parsed as data; not executed by the server | `src/miz/lua.ts`; parser and round-trip tests |
| ZIP members | Traversal, reserved paths, duplicates, expanded sizes and compression ratios checked before decompression | `src/security/archive-policy.ts`; `tests/acceptance.test.ts` |
| Mission output | Source aliases and destination symlinks refused; atomic publication; explicit overwrite | `src/security/files.ts`; atomic-write tests |
| MCP input | Framing and structural budgets before schema validation | `src/security/transport.ts`, `input-budget.ts`; server tests |
| DCS bridge | Hook binds to `127.0.0.1`; bounded socket handling | `runtime/dcs/Hooks/dcs-mcp-hook.lua`; hook/bridge tests |
| Raw execution | Both server environment and hook must explicitly opt in | `src/tools/bridge.ts:399`; hook default and tests |
| Frameworks | Optional loading; original bytes and licences retained | `vendor/lua/manifest.json`; isolated package hash checks |
| Bundle manifest | Pinned official schema; malformed configuration rejected | `scripts/verify/validate-claude-manifest.mjs`; `tests/bundle-manifest.test.ts` |
| Release | Exact-commit gates; manual draft; immutable annotated tag; checksums and download review | `scripts/build/prepare-github-release.mjs`; `tests/release-gates.test.ts` |
| Build inputs | Versioned-source allowlist; ignored local sentinel excluded | `scripts/build/stage-package.mjs`; `tests/package-staging.test.ts` |
| Lua property keys | Special keys stay own data properties and round-trip | `src/miz/lua.ts`; `tests/release-hardening.test.ts` |

## Operating limits

- MCP tools have the invoking user's filesystem permissions. This is not a sandbox:
  the host client must approve tool use and load trusted servers.
- The loopback bridge has no user authentication. Other local processes/users able
  to reach it can issue commands. Do not forward its port or expose it remotely.
- Embedded frameworks execute **inside DCS**. Hashes and licences do not certify
  their safety or flight behaviour.
- Fly-test missions with the required DCS modules. Offline/mocked checks do not
  establish flight acceptance or client app/account eligibility.
- This process does not publish to npm, host a public MCP endpoint, automatically
  update installations, or claim code signing/SLSA attestation.
