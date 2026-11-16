# Build pinned stock Lua for offline CI checks. This is not the DCS interpreter.
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Get-Command cl.exe -ErrorAction Stop | Out-Null
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Lua build output directory must be new' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$root = (Resolve-Path -LiteralPath $OutputDirectory).Path
$archive = Join-Path $root 'lua-5.1.5.tar.gz'
Invoke-WebRequest -Uri 'https://www.lua.org/ftp/lua-5.1.5.tar.gz' -OutFile $archive
# Published by https://www.lua.org/ftp/; checked before extraction or compilation.
$expected = '2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333'
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Lua source SHA-256 mismatch' }
& tar.exe -xzf $archive -C $root
if ($LASTEXITCODE -ne 0) { throw 'Lua source extraction failed' }
$source = Join-Path $root 'lua-5.1.5/src'
Push-Location -LiteralPath $source
try {
    # Core + standard libraries + interpreter; exclude the separate compiler entry point.
    $sources = @(Get-ChildItem -Filter '*.c' | Where-Object { $_.Name -notin @('luac.c', 'print.c') } | ForEach-Object { $_.Name })
    & cl.exe /nologo /O2 /MD /W3 /D_CRT_SECURE_NO_WARNINGS /Fe:lua.exe @sources
    if ($LASTEXITCODE -ne 0) { throw 'MSVC Lua 5.1 compilation failed' }
    & .\lua.exe -v
    if ($LASTEXITCODE -ne 0) { throw 'Built Lua interpreter failed its version check' }
} finally { Pop-Location }
$exe = Join-Path $source 'lua.exe'
Write-Output "Built stock Lua 5.1.5 for mocked/offline checks: $exe"
if ($env:GITHUB_ENV) { "LUA51=$exe" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append }
