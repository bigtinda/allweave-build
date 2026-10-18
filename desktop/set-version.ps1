param(
	[string]$Version = "",
	[switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $PSScriptRoot "src-tauri/tauri.conf.json"
$cargoPath = Join-Path $PSScriptRoot "src-tauri/Cargo.toml"
$lockPath = Join-Path $PSScriptRoot "src-tauri/Cargo.lock"
$configText = [IO.File]::ReadAllText($configPath)
$current = ($configText | ConvertFrom-Json).version
if ($current -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw "Invalid desktop version: $current" }
if ($Rebuild -and $Version) { throw "Use either -Version or -Rebuild." }
if ($Rebuild) {
	$Version = $current
} elseif (-not $Version) {
	$parts = $current.Split('.')
	$Version = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"
}
if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw "Use a version such as 0.1.2." }
if (@($Version.Split('.') | Where-Object { [long]$_ -gt 65535 }).Count) { throw "Windows version components must not exceed 65535." }
if (-not $Rebuild -and [version]$Version -le [version]$current) { throw "New version $Version must be greater than $current." }
$cargoText = [IO.File]::ReadAllText($cargoPath)
$lockText = [IO.File]::ReadAllText($lockPath)
$cargoPattern = '(?s)(\[package\]\s+name = "pi-agent-desktop"\s+version = ")[^"]+(")'
$lockPattern = '(name = "pi-agent-desktop"\s+version = ")[^"]+(")'
if (-not [regex]::IsMatch($cargoText, $cargoPattern) -or -not [regex]::IsMatch($lockText, $lockPattern)) {
	throw "Desktop package version fields are missing."
}
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($configPath, [regex]::Replace($configText, '("version"\s*:\s*")[^"]+(")', "`${1}$Version`${2}"), $utf8)
[IO.File]::WriteAllText($cargoPath, [regex]::Replace($cargoText, $cargoPattern, "`${1}$Version`${2}"), $utf8)
[IO.File]::WriteAllText($lockPath, [regex]::Replace($lockText, $lockPattern, "`${1}$Version`${2}"), $utf8)
Write-Output $Version
