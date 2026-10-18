$ErrorActionPreference = "Stop"
$fixture = Join-Path ([IO.Path]::GetTempPath()) ("allweave-version-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path (Join-Path $fixture "src-tauri") -Force | Out-Null
try {
	Copy-Item -LiteralPath (Join-Path $PSScriptRoot "set-version.ps1") -Destination $fixture
	foreach ($name in @("tauri.conf.json", "Cargo.toml", "Cargo.lock")) {
		Copy-Item -LiteralPath (Join-Path $PSScriptRoot "src-tauri/$name") -Destination (Join-Path $fixture "src-tauri")
	}
	$script = Join-Path $fixture "set-version.ps1"
	$current = (Get-Content (Join-Path $fixture "src-tauri/tauri.conf.json") -Raw | ConvertFrom-Json).version
	$parts = $current.Split('.')
	$expected = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"
	$actual = & $script
	if ($actual -ne $expected) { throw "Default build did not increment patch: $actual" }
	if ((& $script -Rebuild) -ne $expected) { throw "Retry changed the version." }
	foreach ($invalid in @($current, $expected, "1.2", "01.2.3", "65536.0.0")) {
		$rejected = $false
		try { & $script -Version $invalid | Out-Null } catch { $rejected = $true }
		if (-not $rejected) { throw "Accepted invalid or non-increasing version: $invalid" }
	}
	$next = "$([int]$parts[0] + 1).0.0"
	if ((& $script -Version $next) -ne $next) { throw "Explicit version was not applied." }
	$config = Get-Content (Join-Path $fixture "src-tauri/tauri.conf.json") -Raw | ConvertFrom-Json
	if ($config.version -ne $next) { throw "Tauri version differs." }
	foreach ($name in @("Cargo.toml", "Cargo.lock")) {
		$content = Get-Content (Join-Path $fixture "src-tauri/$name") -Raw
		if ($content -notmatch ('name = "pi-agent-desktop"\s+version = "' + [regex]::Escape($next) + '"')) {
			throw "$name version differs."
		}
	}
	Write-Output "Version tests passed: patch increment, explicit version, retry, downgrade rejection and manifest synchronization."
} finally {
	$resolvedFixture = [IO.Path]::GetFullPath($fixture)
	$resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
	if (-not $resolvedFixture.StartsWith($resolvedTemp + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
		throw "Refusing to remove a fixture outside the temporary directory."
	}
	Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
