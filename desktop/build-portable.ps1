param(
	[string]$OutputDirectory = (Join-Path $PSScriptRoot "dist"),
	[string]$NodeExecutable = "",
	[string]$WebView2FixedRuntime = "",
	[switch]$BuildWeb
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$staging = Join-Path $output "KegoPortable"
$archive = Join-Path $output "KegoPortable.zip"
$runtime = Join-Path $staging "runtime"
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
$cargoExecutable = if ($cargo) { $cargo.Source } else { Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe" }


if (-not (Test-Path -LiteralPath $cargoExecutable)) {
	throw "Rust Cargo is required. Install Rust 1.90 or newer and the Visual Studio C++ Build Tools, then run this script again."
}
if (-not $NodeExecutable) {
	$nodeCommand = Get-Command node.exe -ErrorAction Stop
	$NodeExecutable = $nodeCommand.Source
}
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).Path
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "pi-windows-x64.zip"))) {
	throw "The Pi release kernel archive pi-windows-x64.zip is missing from the repository root."
}

if ($BuildWeb) {
	Push-Location $repoRoot
	try {
		npm run build:web
		if ($LASTEXITCODE -ne 0) { throw "Web frontend build failed with exit code $LASTEXITCODE." }
	} finally {
		Pop-Location
	}
}

$frontend = Join-Path $repoRoot "apps/web/dist/index.html"
if (-not (Test-Path -LiteralPath $frontend)) {
	throw "The built frontend is missing at apps/web/dist. Run npm run build:web first, or pass -BuildWeb to this script."
}

Push-Location $PSScriptRoot
try {
	& $cargoExecutable build --release --manifest-path (Join-Path $PSScriptRoot "src-tauri/Cargo.toml")
	if ($LASTEXITCODE -ne 0) { throw "Rust desktop build failed with exit code $LASTEXITCODE." }
} finally {
	Pop-Location
}

$binary = Join-Path $PSScriptRoot "src-tauri/target/release/pi-agent-desktop.exe"
if (-not (Test-Path -LiteralPath $binary)) { throw "Desktop executable was not created at $binary." }

$excludedDirectories = @(
	".git", ".cache", ".vite", ".turbo", ".pytest_cache", "__pycache__",
	"coverage", ".nyc_output", "playwright-report", "test-results", "tmp", "temp",
	"test", "tests", "testing", "__tests__", "__fixtures__", "fixtures", "spec", "specs",
	"test-*", "tests-*", "testing-*", "*-test-*", "*-tests-*", "*-testing-*",
	"spec-*", "specs-*", "*-spec-*", "*-specs-*", "fixture-*", "fixtures-*", "*-fixture-*", "*-fixtures-*",
	"tmp-*", "temp-*", "*-tmp-*", "*-temp-*", "dist-test-*", ".model-generation-*"
)
$excludedFiles = @(
	"test.*", "test-*", "tests.*", "tests-*", "testing.*", "testing-*", "spec.*", "spec-*", "specs.*", "specs-*", "fixture.*", "fixture-*", "fixtures.*", "fixtures-*",
	"*.test.*", "*.test-*", "*.tests.*", "*.tests-*", "*-test.*", "*-test-*", "*-tests.*", "*-tests-*", "*-testing-*",
	"*.spec.*", "*.spec-*", "*-spec.*", "*-spec-*", "*.fixtures.*", "*.fixture.*", "*-fixture.*", "*-fixtures.*",
	"coverage-*", "*.log", "*.tmp", "*.temp", "tmp.*", "tmp-*", "temp.*", "temp-*", "*.tsbuildinfo",
	"*.cpuprofile", "*.prof", "npm-debug.log*", ".DS_Store"
)
function Copy-RuntimeTree {
	param([string]$Source, [string]$Destination)
	New-Item -ItemType Directory -Path $Destination -Force | Out-Null
	$arguments = @($Source, $Destination, "/E", "/COPY:DAT", "/DCOPY:DAT", "/R:2", "/W:1", "/XJ", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP", "/XD") + $excludedDirectories + @("/XF") + $excludedFiles
	& robocopy @arguments
	if ($LASTEXITCODE -ge 8) { throw "Copying runtime files from $Source failed with robocopy exit code $LASTEXITCODE." }
}

New-Item -ItemType Directory -Path $output -Force | Out-Null
if (Test-Path -LiteralPath $staging) {
	$resolvedStaging = [System.IO.Path]::GetFullPath($staging)
	$resolvedOutput = [System.IO.Path]::GetFullPath($output)
	if (-not $resolvedStaging.StartsWith($resolvedOutput + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
		throw "Refusing to replace a package directory outside the selected output directory."
	}
	Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
}
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Copy-Item -LiteralPath $binary -Destination (Join-Path $staging "Kego.exe") -Force
Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $runtime "node.exe") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "package.json") -Destination $runtime -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "tsconfig.json") -Destination $runtime -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "tsconfig.base.json") -Destination $runtime -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "pi-windows-x64.zip") -Destination $runtime -Force

foreach ($path in @("apps/server/src", "apps/shared", "apps/web/dist", "packages")) {
	$source = Join-Path $repoRoot $path
	$destination = Join-Path $runtime $path
	Copy-RuntimeTree -Source $source -Destination $destination
}
Copy-Item -LiteralPath (Join-Path $repoRoot "apps/server/package.json") -Destination (Join-Path $runtime "apps/server/package.json") -Force

$nodeModules = Join-Path $repoRoot "node_modules"
if (-not (Test-Path -LiteralPath $nodeModules)) { throw "Repository node_modules is missing. Run npm ci --ignore-scripts first." }
Copy-RuntimeTree -Source $nodeModules -Destination (Join-Path $runtime "node_modules")

New-Item -ItemType Directory -Path (Join-Path $staging "workspaces") -Force | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines((Join-Path $staging "workspace-roots.txt"), [string[]]@(
	"# One authorized workspace folder per line. Relative paths use this folder."
	"workspaces"
), $utf8NoBom)
[System.IO.File]::WriteAllLines((Join-Path $staging "README.txt"), [string[]]@(
	"Kego Windows desktop"
	""
	"Double-click Kego.exe to open the desktop application. The program stores its sessions, Pi settings, kernel, and WebView data in the data folder next to the executable."
	""
	"By default, the workspaces folder is authorized. Add one existing folder path per line to workspace-roots.txt to allow other projects. Relative paths are resolved from this folder. Restart the application after editing the file."
	""
	"The application uses the Windows WebView2 Runtime. If it is not installed on the target PC, rebuild with -WebView2FixedRuntime pointing to an extracted Microsoft Fixed Version WebView2 runtime folder."
	""
	"The Pi kernel is stored in runtime/pi-windows-x64.zip. Replace that archive with a new official Windows x64 Pi release to update the kernel; the next launch extracts it into data/pi-kernel."
), $utf8NoBom)

$temporaryArtifactPattern = '(^|[._-])(test|tests|testing|spec|specs|fixtures?|tmp|temp)([._-]|$)|^(coverage|\.nyc_output|\.cache|\.vite|\.model-generation-)'
$temporaryEntries = @(Get-ChildItem -LiteralPath $staging -Force -Recurse | Where-Object {
	$_.Name -match '(^|[._-])(test|tests|testing|spec|fixtures?)([._-]|$)|^(coverage|\.nyc_output|\.cache|\.vite|\.model-generation-)' -or
	$_.Name -match '\.(test|spec)\.' -or
	$_.Name -match '\.(log|tmp|temp|tsbuildinfo|cpuprofile|prof)$' -or
	$_.Name -match $temporaryArtifactPattern
})
$resolvedOutput = (Resolve-Path -LiteralPath $output).Path
$resolvedStaging = (Resolve-Path -LiteralPath $staging).Path
if (-not $resolvedStaging.StartsWith($resolvedOutput + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
	throw "Refusing to clean package artifacts outside the selected output directory."
}
foreach ($entry in $temporaryEntries | Sort-Object { $_.FullName.Length } -Descending) {
	if (-not (Test-Path -LiteralPath $entry.FullName)) { continue }
	$resolvedEntry = [System.IO.Path]::GetFullPath($entry.FullName)
	if (-not $resolvedEntry.StartsWith($resolvedStaging + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
		throw "Refusing to remove an artifact outside the package staging directory: $resolvedEntry"
	}
	Remove-Item -LiteralPath $resolvedEntry -Recurse -Force
}
$remainingTemporaryEntries = Get-ChildItem -LiteralPath $staging -Force -Recurse | Where-Object {
	$_.Name -match $temporaryArtifactPattern -or
	$_.Name -match '\.(log|tmp|temp|tsbuildinfo|cpuprofile|prof)$'
}
if ($remainingTemporaryEntries) {
	$example = $remainingTemporaryEntries[0].FullName
	throw "Packaging contains a development or test artifact that must be excluded: $example"
}
if ($temporaryEntries.Count -gt 0) {
	Write-Output "Excluded $($temporaryEntries.Count) development/test artifact entries from package."
}
if (Test-Path -LiteralPath (Join-Path $staging "data")) {
	throw "Refusing to package local application data from $staging/data."
}

if ($WebView2FixedRuntime) {
	$webviewPath = (Resolve-Path -LiteralPath $WebView2FixedRuntime).Path
	if (-not (Test-Path -LiteralPath (Join-Path $webviewPath "msedgewebview2.exe"))) {
		throw "The selected fixed WebView2 runtime folder does not contain msedgewebview2.exe."
	}
	$webviewDestination = Join-Path $staging "webview2-runtime"
	New-Item -ItemType Directory -Path $webviewDestination -Force | Out-Null
	Get-ChildItem -LiteralPath $webviewPath -Force | ForEach-Object {
		Copy-Item -LiteralPath $_.FullName -Destination $webviewDestination -Recurse -Force
	}
}

if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
& tar.exe -a -c -f $archive -C $output "KegoPortable"
if ($LASTEXITCODE -ne 0) { throw "Creating the portable ZIP failed with exit code $LASTEXITCODE." }
Write-Output "Portable desktop package created: $archive"
