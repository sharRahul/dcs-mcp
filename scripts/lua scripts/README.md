# Bundled mission frameworks

These are the Lua source files supplied for optional mission scripting. They ship with the npm tarball, Claude Desktop extension and ChatGPT plugin. DCS-MCP searches the user's configured DCS script folders first and uses these copies only as a fallback. An explicitly provided framework path always wins. The server reads and embeds Lua as data; DCS executes it when the saved mission runs.

| File | Identification in supplied file | Upstream project | License copy |
| --- | --- | --- | --- |
| `mist_4_5_126.lua` | Named 4.5.126; its internal `mist.build` is 125 | [MIST / Mission Scripting Tools](https://github.com/mrSkortch/MissionScriptingTools) | [GPL-3.0](licenses/MIST-LICENSE.md) |
| `Moose.lua` | Header identifies `a3d77a5a7166c5aee4a2b596a22ec30b19a9dde6`, 2025-12-30 | [MOOSE](https://github.com/FlightControl-Master/MOOSE), [single-file builds](https://github.com/FlightControl-Master/MOOSE_INCLUDE) | [GPL-3.0](licenses/MOOSE-LICENSE) |
| `skynet-iads-compiled.lua` | 3.3.0, build 2023-12-29 | [Skynet-IADS](https://github.com/walder/Skynet-IADS) | [Apache-2.0](licenses/Skynet-IADS-LICENSE.md) |
| `Splash_Damage_3.4.5_Standard_With_Ground_Ordnance.lua` | 3.4.5 Standard With Ground Ordnance | [Splash Damage](https://github.com/stephenpostlethwaite/DCSSplashDamageScript) | [MIT](licenses/Splash-Damage-LICENSE) |

The supplied Lua files are preserved byte-for-byte. `manifest.json` records their SHA-256 hashes, sizes and the identification above; it does not claim a byte-for-byte match against an independently downloaded upstream release. License texts were retrieved from the linked upstream repositories. These frameworks are not relicensed under DCS-MCP's license.

Skynet requires MIST, which is loaded first automatically. MOOSE and Splash Damage do not require MIST. The bundled Splash Damage variant includes ground-ordnance tracking; choose a different local build or explicit `frameworkPaths.splash` if you want different behavior. Frameworks are never added to missions unless requested.

Embedding and archive-byte checks do not establish compatibility in flight. Test the mission and selected versions in DCS. Update these supplied sources, their hashes and notices together when replacing a framework.
