param(
	[string]$Version = "",
	[switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $PSScriptRoot "desktop.json"
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
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($configPath, [regex]::Replace($configText, '("version"\s*:\s*")[^"]+(")', "`${1}$Version`${2}"), $utf8)
Write-Output $Version
