param(
	[string]$OutputDirectory = (Join-Path $PSScriptRoot "dist"),
	[string]$NodeExecutable = "",
	[string]$WebView2FixedRuntime = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$staging = Join-Path $output "installer-payload"
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
$nodeDirectory = Split-Path -Parent $NodeExecutable
$npmCommand = Join-Path $nodeDirectory "npm.cmd"
$npmPackage = Join-Path $nodeDirectory "node_modules/npm"
if (-not (Test-Path -LiteralPath $npmCommand) -or -not (Test-Path -LiteralPath (Join-Path $npmPackage "bin/npm-cli.js"))) {
	throw "The selected Node.js installation must include npm.cmd and node_modules/npm so bundled Pi package installation remains available."
}

$frontend = Join-Path $repoRoot "apps/web/dist/index.html"
if (-not (Test-Path -LiteralPath $frontend)) {
	throw "The built frontend is missing at apps/web/dist. Run desktop/build-installer.ps1 first."
}
$remoteDaemonNames = @(
	"linux-x64", "linux-arm64", "android-x64", "android-arm64",
	"darwin-x64", "darwin-arm64", "windows-x64", "windows-arm64"
)
$missingRemoteDaemons = @($remoteDaemonNames | Where-Object {
	$executable = if ($_ -like "windows-*") { "pi-env.exe" } else { "pi-env" }
	-not (Test-Path -LiteralPath (Join-Path $repoRoot "packages/env/bin/pi-env-$_/$executable"))
})
if ($missingRemoteDaemons.Count -gt 0) {
	$names = $missingRemoteDaemons -join ", "
	throw "Remote SSH projects require prebuilt pi-env daemons. Missing: $names. Run npm run hydrate:env-daemons, then retry."
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
	"node_modules",
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
Copy-Item -LiteralPath $binary -Destination (Join-Path $staging "AllWeaveBuild.exe") -Force
Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $runtime "node.exe") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "package.json") -Destination $runtime -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "tsconfig.json") -Destination $runtime -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "tsconfig.base.json") -Destination $runtime -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination (Join-Path $staging "LICENSE") -Force

foreach ($path in @("apps/server/src", "apps/shared", "apps/web/dist", "packages")) {
	$source = Join-Path $repoRoot $path
	$destination = Join-Path $runtime $path
	Copy-RuntimeTree -Source $source -Destination $destination
}
Copy-Item -LiteralPath (Join-Path $repoRoot "apps/server/package.json") -Destination (Join-Path $runtime "apps/server/package.json") -Force

$nodeModules = Join-Path $repoRoot "node_modules"
if (-not (Test-Path -LiteralPath $nodeModules)) { throw "Repository node_modules is missing. Run npm ci --ignore-scripts first." }
Push-Location $repoRoot
try {
	$npmOutput = @(& $npmCommand ls --parseable --all --omit=dev --workspace=@pi-console/server 2>&1)
	$npmExitCode = $LASTEXITCODE
} finally {
	Pop-Location
}
if ($npmExitCode -ne 0) {
	$detail = ($npmOutput | Select-Object -Last 8) -join [Environment]::NewLine
	throw "Could not resolve the server's production dependency tree with npm ls (exit code $npmExitCode). $detail"
}
$workspaceDirectories = @{}
foreach ($manifest in @(
	(Get-Item -LiteralPath (Join-Path $repoRoot "apps/server/package.json"))
) + @(Get-ChildItem -LiteralPath (Join-Path $repoRoot "packages") -Directory | ForEach-Object {
	Get-Item -LiteralPath (Join-Path $_.FullName "package.json") -ErrorAction SilentlyContinue
} | Where-Object { $_ })) {
	$package = Get-Content -LiteralPath $manifest.FullName -Raw | ConvertFrom-Json
	if ($package.name) { $workspaceDirectories[$package.name] = $manifest.DirectoryName }
}

$runtimeNodeModules = Join-Path $runtime "node_modules"
New-Item -ItemType Directory -Path $runtimeNodeModules -Force | Out-Null
$copiedWorkspaces = @{}
$copiedExternalDependencies = @{}
foreach ($entry in $npmOutput) {
	$source = ([string]$entry).Trim()
	$manifestPath = Join-Path $source "package.json"
	if (-not (Test-Path -LiteralPath $manifestPath)) { continue }
	$package = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
	if ($workspaceDirectories.ContainsKey($package.name)) {
		$copiedWorkspaces[$package.name] = $true
		continue
	}
	if ($source -notmatch '\\node_modules\\' -or $copiedExternalDependencies.ContainsKey($source)) { continue }
	$relativePath = [System.IO.Path]::GetRelativePath($repoRoot, $source)
	Copy-RuntimeTree -Source $source -Destination (Join-Path $runtime $relativePath)
	$copiedExternalDependencies[$source] = $true
}
if (-not $copiedWorkspaces.ContainsKey("@earendil-works/pi-coding-agent")) {
	throw "The production dependency tree did not include @earendil-works/pi-coding-agent."
}

# Keep npm available for installing Pi extensions without requiring Node.js on the target PC.
Copy-Item -LiteralPath $npmCommand -Destination (Join-Path $runtime "npm.cmd") -Force
Copy-Item -LiteralPath $npmPackage -Destination $runtimeNodeModules -Recurse -Force
Write-Output "Included $($copiedWorkspaces.Count) Pi SDK workspace packages and $($copiedExternalDependencies.Count) production dependency packages."

New-Item -ItemType Directory -Path (Join-Path $staging "workspaces") -Force | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines((Join-Path $staging "workspace-roots.txt"), [string[]]@(
	"# One authorized workspace folder per line. Relative paths use this folder."
	"workspaces"
), $utf8NoBom)
[System.IO.File]::WriteAllLines((Join-Path $staging "README.txt"), [string[]]@(
	"AllWeave Build - Windows desktop"
	""
	"Double-click AllWeaveBuild.exe to open the desktop application. The program stores its sessions, Pi settings, and WebView data in the data folder next to the executable."
	""
	"AI application plugins are developed from the Plugin Development chat. Their default workspace, installed manifests, and project data persist under the data folder."
	""
	"By default, the workspaces folder is authorized. Add one existing folder path per line to workspace-roots.txt to allow other projects. Relative paths are resolved from this folder. Restart the application after editing the file."
	""
	"The application requires the Windows WebView2 Runtime. The installer checks this prerequisite."
	""
	"The Pi coding-agent SDK is bundled from the project source and runs inside the application service."
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

$releaseVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot "src-tauri/tauri.conf.json") -Raw | ConvertFrom-Json).version
[IO.File]::WriteAllText((Join-Path $staging "version.txt"), "$releaseVersion`n", $utf8NoBom)
Write-Output "Installer runtime staged: $staging"
