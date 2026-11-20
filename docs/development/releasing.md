# Build and release packages

## Build on GitHub

The **Build installable packages** workflow in `.github/workflows/packages.yml` runs on pushes to `main`, version tags and manual **Run workflow** requests. It checks the code and tests, builds the npm tarball, installs and tests that tarball outside the checkout, validates the Claude Desktop extension, and verifies the ChatGPT plugin.

After a successful run, download its three artifacts from [GitHub Actions](https://github.com/sharRahul/dcs-mcp/actions/workflows/packages.yml):

| Artifact | Contents |
| --- | --- |
| `dcs-mcp-server-<version>` | Installable npm `.tgz` |
| `dcs-claude-desktop-<version>` | Claude Desktop `.mcpb` |
| `dcs-chatgpt-plugin-<version>` | Complete local ChatGPT plugin folder with dependencies |

Artifact downloads are zipped by GitHub; extract the download before using the tarball, extension or plugin. They are retained for 30 days and may require GitHub sign-in. A maintainer can attach the verified files to a GitHub Release for longer-lived distribution. Generated packages do not belong in source control.

No npm account or npm secret is required to build these files or install the tarball. The workflow never runs `npm publish` and has read-only repository permissions. See [GitHub artifact documentation](https://docs.github.com/en/actions/tutorials/store-and-share-data).

## npm registry status

`npm view dcs-mcp-server version --registry=https://registry.npmjs.org` returned E404 on 2026-11-19. A valid local tarball does not make the package available from npm. A registry 404 also does not guarantee that npm will permit a particular account to publish that name.

Users should follow the [GitHub setup](../../README.md#get-dcs-mcp), which needs no npm login. Publication is a separate maintainer action requiring npm authentication. The installer defaults to local mode and does not silently switch to registry mode when a build is missing.

## Recorded preflight for 0.6.4

These are earlier local results, not a substitute for running the checks on the exact revision being published. File counts and sizes change as documentation and source change.

| Check | Result |
|---|---|
| `npm run check` (`tsc --noEmit`) | clean |
| `npm test` | 388 pass, 0 fail, 1 skipped (389 total) |
| `npm pack --dry-run` | `dcs-mcp-server-0.6.4.tgz`, 542 files, 1.3 MB packed / 6.3 MB unpacked |
| Tarball installed into a scratch project | 98 packages, no install scripts |
| `./node_modules/.bin/dcs-mcp-server --version` | `0.6.4` |
| `… install-claude-desktop --published --dry-run` | `would-add dcs`, `cmd /c npx -y dcs-mcp-server` |
| Version agreement | `package.json`, `server.json` and `package-lock.json` all 0.6.4 |

The last two matter together: the packed artifact resolves its own `bin`, and the entry it
would write for a user is the platform-correct one. What it cannot prove is that `npx` finds
the package, which is exactly what publishing fixes.

`prepublishOnly` runs `clean && build && test`, so `npm publish` rebuilds `dist/` itself. It
deletes `dist/` first: a Claude Desktop entry installed with `--local` points there and is
broken for the minute or two the publish takes, then works again.

## Prepare and publish

From a clean checkout of the intended revision, run each command in order and stop on failure:

```powershell
npm ci
npm run check
npm run build
npm test
npm pack --dry-run
npm pack
```

Inspect the listed contents for local files. Install the resulting versioned tarball into a temporary project with `npm install --ignore-scripts <absolute-path-to-tarball>`, then run its installed bin with `--version` and `install-claude-desktop --local --dry-run --config <temporary-config-path>`. The dry run must point to that permanent installation and leave the temporary config unwritten. Do not register Claude Desktop to a throwaway scratch folder for actual use.

Only the maintainer performs the following authenticated steps, after reviewing the package:

```powershell
npm login
```

```powershell
npm publish --access public
```

With 2FA on your npm account the second command asks for a code, or takes `--otp=<code>`.

Publishing makes the package public. Verify the package contents, version and publishing account before running the command. Do not put credentials or authentication codes in repository files.

## After publication

1. Check the registry answers:

   ```powershell
   npm view dcs-mcp-server version
   ```

   ```powershell
   npx -y dcs-mcp-server --version
   ```

2. Only after both checks succeed, offer the npm setup route and update the unpublished notices in `README.md`, `docs/user/claude-desktop.md`, `docs/reference/technical-reference.md`, `plugins/dcs-chatgpt/README.md` and `CLAUDE.md`. Keep the clone route available. Do not change the historical preflight results to imply that publication was verified before it happened.

   The future Claude Desktop installer command is:

   ```powershell
   npx -y dcs-mcp-server install-claude-desktop --published
   ```

   It writes `cmd /c npx -y dcs-mcp-server` on Windows and plain `npx` elsewhere. This validates configuration generation only; actually starting it requires the registry package. The installer intentionally keeps local mode as its default.

   The future registry-based Codex command is `codex mcp add dcs -- npx -y dcs-mcp-server`. Hook installation from the registry is `npx -y dcs-mcp-server install-hook`. These commands are unavailable while npm returns E404.

3. Optional: tag the exact verified release commit. Check existing tags before creating a new one:

   ```powershell
   git tag -a v0.6.4 -m "0.6.4"; git push origin v0.6.4
   ```

4. Optional: the MCP registry. `server.json` and the `mcpName` field in `package.json` are
   already filled in for `io.github.sharRahul/dcs-mcp`, and a registry entry points at the
   npm package, so it can only be submitted after the publish above. The submission tooling
   has not been run from this repository, so nothing here states how it behaves.

## Later releases

GitHub Actions can also publish to npm once a maintainer configures an npm trusted publisher (OIDC) for the repository and a dedicated publishing workflow. That is separate from the build workflow here; package-owner setup is still required. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). No npm token or login is committed to this repository.

Bump the version in `package.json`, `server.json` and `package-lock.json` together — patch
only while the minor digit is reserved (see `CLAUDE.md`) — then `npm publish` again. Rebuild
the Claude Desktop extension too if you distribute it: `npm run bundle:build` names the file
after the version, so an old `.mcpb` keeps its old number and is easy to mistake for current.
