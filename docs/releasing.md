# Releasing to npm

`dcs-mcp-server` has **never been published**. `https://registry.npmjs.org/dcs-mcp-server`
returned 404 on 2026-11-19 and the name appears in no search result, so it is free and the
first publish claims it. Everything in the docs that starts `npx -y dcs-mcp-server` depends
on this, including `install-claude-desktop --published`, which otherwise writes a Claude
Desktop entry the app cannot start.

Publishing needs your npm credentials, so the two commands at the bottom are yours to run.
Everything that can be checked without them has been.

## What is already verified for 0.6.4

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

## Publish

```powershell
npm login
```

```powershell
npm publish --access public
```

With 2FA on your npm account the second command asks for a code, or takes `--otp=<code>`.

**This cannot be undone.** 0.6.4 can be unpublished only within 72 hours, and the version
number can never be reused afterwards — a mistake costs a version bump, not a repair.

## Afterwards

1. Check the registry answers:

   ```powershell
   npm view dcs-mcp-server version
   ```

   ```powershell
   npx -y dcs-mcp-server --version
   ```

2. Delete the three "not published yet" notices, which are now wrong:
   - the blockquote under `## Set it up once` in `README.md`
   - the blockquote near the top of `docs/claude-desktop.md`
   - the paragraph under `## Install` in `docs/technical-reference.md`

   `README.md` and `docs/claude-desktop.md` also present a clone route first and the npx
   route as "once released"; reorder them if you want npx to lead.

3. Optional: tag the release. The repository has no tags yet, so this starts the convention:

   ```powershell
   git tag -a v0.6.4 -m "0.6.4"; git push origin v0.6.4
   ```

4. Optional: the MCP registry. `server.json` and the `mcpName` field in `package.json` are
   already filled in for `io.github.sharRahul/dcs-mcp`, and a registry entry points at the
   npm package, so it can only be submitted after the publish above. The submission tooling
   has not been run from this repository, so nothing here states how it behaves.

## Later releases

Bump the version in `package.json`, `server.json` and `package-lock.json` together — patch
only while the minor digit is reserved (see `CLAUDE.md`) — then `npm publish` again. Rebuild
the Claude Desktop extension too if you distribute it: `npm run bundle:build` names the file
after the version, so an old `.mcpb` keeps its old number and is easy to mistake for current.
