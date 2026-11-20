# Controlled GitHub releases

DCS MCP is distributed through **GitHub Releases**. The `.tgz` is an installable
local npm package; it does not require publishing to the npm registry or an npm
account. There is no npm publishing workflow, npm secret or registry release step.
`package.json` also sets `private: true` to prevent accidental registry publication.

## Downloads

Use the files on the [latest release](https://github.com/sharRahul/dcs-sortie-mcp/releases/latest):

| Download | Use |
| --- | --- |
| `dcs-claude-desktop-<version>.mcpb` | Open in Claude Desktop |
| `dcs-chatgpt-plugin-<version>.zip` | Extract into `plugins/dcs-chatgpt` in a clone and install through its local marketplace |
| `dcs-others-<version>.zip` | Codex and Others; contains `dcs-sortie-mcp-<version>.tgz` |
| `SHA256SUMS.txt` | SHA-256 hashes for the payloads and acceptance record |
| `release-acceptance.json` | Exact source commit, accepted workflows and audit results |

Checksums record integrity; they are not signatures or SLSA attestations.
The [app connection guide](../user/clients.md) explains installation.

## Acceptance gates

Use a committed `main` revision with matching versions in `package.json`,
`package-lock.json` and `server.json`. Never move or replace a release tag.

Require successful **CI** and **Build installable packages** push runs for that
exact commit, every job successful, with no warning/failure annotations. CI covers
Windows Node 20/22/24, Lua 5.1 checks and pinned pydcs data regeneration. Package
acceptance includes dependency audit, isolated installs, hook installation,
framework hashes, mission save/reopen, manifest validation and plugin checks.

The full dependency audit must report zero known vulnerabilities, including build
tools. See [security acceptance](security-acceptance.md) for scope and limits.

## Prepare and inspect a draft

1. Commit and push the intended revision to `main`. Wait for both acceptance workflows.
2. Open **Actions → Prepare GitHub release → Run workflow** on `main`. Enter the
   exact version, for example `0.1.0`, without `v`.
3. Preparation refuses mismatched versions, missing checks, existing tags,
   expired/missing artifacts or a moved `main`. It downloads the tested artifacts,
   adds release wrappers, checksums and an acceptance record, then creates an
   annotated tag and a **draft** release.
4. Inspect the draft notes, commit and downloads. Download every asset, verify
   every checksum, and confirm the tag resolves to the accepted commit.
5. Publish the inspected draft from GitHub Releases, or use
   `gh release edit v0.1.0 --draft=false --latest` after inspection.

Only the manually dispatched draft job has repository write permissions. Normal
CI and package builds remain read-only. Preparation never publishes the draft
automatically and never runs `npm publish`.

If preparation fails after tag creation, inspect the tag and draft before recovery.
Do not delete or retarget tags to make a rerun pass. Recover the interrupted upload
on the same accepted commit, or choose a new version.

## Build locally

Run from a clean checkout and stop on failure:

```powershell
npm ci
npm audit --audit-level=low
npm run check
npm run build
npm test
npm run package:build
npm run package:verify
npm run bundle:build
npm run bundle:validate
npm run bundle:verify
npm run plugin:build
npm run plugin:verify
```

None of these commands publish to a registry. Release assets come from the
accepted GitHub build. Generated packages stay outside source control. Actions
artifacts are useful between releases but expire after their retention period.

## Future versions

Bump package, lockfile and MCP metadata versions together, then repeat the gates
and draft inspection. npm registry distribution would require a separate explicit
decision. Unused registry metadata in `server.json` does not mean a package or MCP
registry entry has been published.
