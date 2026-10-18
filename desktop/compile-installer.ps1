param(
	[Parameter(Mandatory = $true)][string]$NsisCompiler,
	[string]$OutputDirectory = (Join-Path $PSScriptRoot "dist")
)

$ErrorActionPreference = "Stop"
$output = [IO.Path]::GetFullPath($OutputDirectory)
$payload = Join-Path $output "installer-payload"
$releaseVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot "src-tauri/tauri.conf.json") -Raw | ConvertFrom-Json).version
$payloadVersion = (Get-Content -LiteralPath (Join-Path $payload "version.txt") -Raw).Trim()
$executableVersion = (Get-Item -LiteralPath (Join-Path $payload "AllWeaveBuild.exe")).VersionInfo.ProductVersion
if ($payloadVersion -ne $releaseVersion -or $executableVersion -ne $releaseVersion) {
	throw "Staged runtime and desktop executable must match desktop version $releaseVersion. Rebuild before packaging."
}
$installer = Join-Path $output "AllWeaveBuild-$releaseVersion-windows-x64-setup.exe"
& $NsisCompiler /V3 /WX "/DAPP_VERSION=$releaseVersion" "/DPAYLOAD=$payload" "/DOUTPUT_FILE=$installer" (Join-Path $PSScriptRoot "installer.nsi")
if ($LASTEXITCODE -ne 0) { throw "Installer compilation failed ($LASTEXITCODE)." }
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$installer.sha256", "$hash  $([IO.Path]::GetFileName($installer))`n", (New-Object Text.UTF8Encoding($false)))
Write-Output "Installer created: $installer"
Write-Output "SHA256: $hash"
