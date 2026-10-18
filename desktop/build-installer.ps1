param(
	[string]$OutputDirectory = (Join-Path $PSScriptRoot "dist"),
	[string]$NsisCompiler = "",
	[string]$NodeExecutable = "",
	[string]$WebView2FixedRuntime = "",
	[string]$Version = "",
	[switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $NsisCompiler) {
	$command = Get-Command makensis.exe -ErrorAction SilentlyContinue
	if ($command) { $NsisCompiler = $command.Source }
	foreach ($candidate in @(
		(Join-Path ${env:ProgramFiles(x86)} "NSIS/makensis.exe"),
		(Join-Path $repoRoot ".artifacts/installer-tools/nsis-3.12/makensis.exe")
	)) {
		if (-not $NsisCompiler -and (Test-Path -LiteralPath $candidate)) { $NsisCompiler = $candidate }
	}
}
if (-not $NsisCompiler -or -not (Test-Path -LiteralPath $NsisCompiler)) {
	throw "Install NSIS 3 or pass -NsisCompiler C:/path/to/makensis.exe."
}
$NsisCompiler = (Resolve-Path -LiteralPath $NsisCompiler).Path
New-Item -ItemType Directory -Path $output -Force | Out-Null
# Reserve a new version before building; a failed build may be retried with -Rebuild.
& (Join-Path $PSScriptRoot "set-version.ps1") -Version $Version -Rebuild:$Rebuild
Push-Location $repoRoot
try {
	node scripts/hydrate-desktop-models.mjs
	if ($LASTEXITCODE -ne 0) { throw "Pinned model catalog hydration failed ($LASTEXITCODE)." }
	npm run hydrate:env-daemons
	if ($LASTEXITCODE -ne 0) { throw "Remote SSH daemon hydration failed ($LASTEXITCODE)." }
	npm run build:web
	if ($LASTEXITCODE -ne 0) { throw "Web frontend build failed ($LASTEXITCODE)." }
} finally {
	Pop-Location
}
& (Join-Path $PSScriptRoot "stage-runtime.ps1") -OutputDirectory $output -NodeExecutable $NodeExecutable -WebView2FixedRuntime $WebView2FixedRuntime
& (Join-Path $PSScriptRoot "compile-installer.ps1") -OutputDirectory $output -NsisCompiler $NsisCompiler
