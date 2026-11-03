param(
	[string]$OutputDirectory = (Join-Path $PSScriptRoot "dist"),
	[string]$NodeExecutable = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$staging = Join-Path $output "installer-payload"
$runtime = Join-Path $staging "runtime"
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

Push-Location $PSScriptRoot
try {
	& $NodeExecutable (Join-Path $repoRoot "scripts/hydrate-env-daemons.mjs")
	if ($LASTEXITCODE -ne 0) { throw "TypeScript daemon bundling failed." }
	& $NodeExecutable (Join-Path $PSScriptRoot "package-shell.mjs")
	if ($LASTEXITCODE -ne 0) { throw "TypeScript desktop packaging failed." }
} finally {
	Pop-Location
}

$binary = Join-Path $PSScriptRoot "dist/electron/AllWeaveBuild-win32-x64/AllWeaveBuild.exe"
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
	"*.cpuprofile", "*.prof", "*.map", "npm-debug.log*", ".DS_Store"
)
function Copy-RuntimeTree {
	param([string]$Source, [string]$Destination, [switch]$SourceWorkspace, [switch]$Dependency)
	New-Item -ItemType Directory -Path $Destination -Force | Out-Null
	$directoryExclusions = $excludedDirectories
	$fileExclusions = $excludedFiles
	if ($Dependency) {
		$directoryExclusions = @(".git", ".cache", ".vite", "coverage", ".nyc_output", "test", "tests", "__tests__", "__fixtures__", "fixtures")
		$fileExclusions = @("*.test.*", "*.spec.*", "*.log", "*.tmp", "*.temp", "*.tsbuildinfo", "*.cpuprofile", "*.prof", "*.map", ".DS_Store")
	}
	if ($SourceWorkspace) { $directoryExclusions += @("dist", "dist-chrome", "dist-firefox") }
	$arguments = @($Source, $Destination, "/E", "/COPY:DAT", "/DCOPY:DAT", "/R:2", "/W:1", "/XJ", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP", "/XD") + $directoryExclusions + @("/XF") + $fileExclusions
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
Copy-Item -LiteralPath (Split-Path -Parent $binary) -Destination (Join-Path $staging "shell") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "package.json") -Destination $runtime -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "tsconfig.json") -Destination $runtime -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "tsconfig.base.json") -Destination $runtime -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination (Join-Path $staging "LICENSE") -Force

foreach ($path in @("apps/server/src", "apps/shared", "apps/web/dist", "packages")) {
	$source = Join-Path $repoRoot $path
	$destination = Join-Path $runtime $path
	Copy-RuntimeTree -Source $source -Destination $destination -SourceWorkspace:($path -eq "packages")
}
Copy-Item -LiteralPath (Join-Path $repoRoot "apps/server/package.json") -Destination (Join-Path $runtime "apps/server/package.json") -Force

$nodeModules = Join-Path $repoRoot "node_modules"
if (-not (Test-Path -LiteralPath $nodeModules)) { throw "Repository node_modules is missing. Run npm ci --ignore-scripts first." }
Push-Location $repoRoot
$previousErrorAction = $ErrorActionPreference
try {
	$ErrorActionPreference = "Continue"
	$npmOutput = @(& $npmCommand ls --parseable --omit=dev --all --workspace=@pi-console/server 2>&1)
	$npmExitCode = $LASTEXITCODE
} finally {
	$ErrorActionPreference = $previousErrorAction
	Pop-Location
}
if ($npmExitCode -ne 0) {
	$metadataProblems = @($npmOutput | Where-Object { "$_" -match '^npm error (extraneous|invalid):' }).Count -gt 0
	$treeResolved = @($npmOutput | Where-Object {
		"$_" -match 'node_modules\\@earendil-works\\pi-coding-agent\s*$'
	}).Count -gt 0
	if ($npmExitCode -eq 1 -and $metadataProblems -and $treeResolved) {
		Write-Warning "npm ls reported extraneous or invalid packages; continuing with the resolved production tree."
	} else {
		$detail = ($npmOutput | Select-Object -Last 8) -join [Environment]::NewLine
		throw "Could not resolve the server's production dependency tree with npm ls (exit code $npmExitCode). $detail"
	}
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
	if (-not [System.IO.Path]::IsPathRooted($source)) { continue }
	$manifestPath = Join-Path $source "package.json"
	if (-not (Test-Path -LiteralPath $manifestPath)) { continue }
	$package = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
	if ($workspaceDirectories.ContainsKey($package.name)) {
		$copiedWorkspaces[$package.name] = $true
		continue
	}
	if ($source -notmatch '\\node_modules\\' -or $copiedExternalDependencies.ContainsKey($source)) { continue }
	if (-not $source.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
		throw "Dependency path is outside the repository: $source"
	}
	$relativePath = $source.Substring($repoRoot.Length).TrimStart('\', '/')
	Copy-RuntimeTree -Source $source -Destination (Join-Path $runtime $relativePath) -Dependency
	$copiedExternalDependencies[$source] = $true
}
if (-not $copiedWorkspaces.ContainsKey("@earendil-works/pi-coding-agent")) {
	throw "The production dependency tree did not include @earendil-works/pi-coding-agent."
}

# Keep npm available for installing Pi extensions without requiring Node.js on the target PC.
$npmLauncher = @'
@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\shell\AllWeaveBuild.exe" "%~dp0node_modules\npm\bin\npm-cli.js" %*
exit /b %ERRORLEVEL%
'@
[IO.File]::WriteAllText((Join-Path $runtime "npm.cmd"), $npmLauncher, (New-Object Text.UTF8Encoding($false)))
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
	"Double-click shell/AllWeaveBuild.exe to open the desktop application. The program stores its sessions, Pi settings, and WebView data in the installation's data folder."
	""
	"By default, the workspaces folder is authorized. Add one existing folder path per line to workspace-roots.txt to allow other projects. Relative paths are resolved from this folder. Restart the application after editing the file."
	""
	"The application includes its Chromium desktop runtime."
	""
	"The Pi coding-agent SDK is bundled from the project source and runs inside the application service."
), $utf8NoBom)

$temporaryArtifactPattern = '(^|[._-])(test|tests|testing|spec|specs|fixtures?|tmp|temp)([._-]|$)|^(coverage|\.nyc_output|\.cache|\.vite|\.model-generation-)'
function Test-RuntimeArtifact {
	param([System.IO.FileSystemInfo]$Entry)
	if ($Entry.FullName -match '[\\/]node_modules[\\/]') {
		if ($Entry.PSIsContainer) { return $Entry.Name -in @("test", "tests", "__tests__", "__fixtures__", "fixtures", "coverage", ".nyc_output", ".cache", ".vite") }
		return $Entry.Name -match '\.(test|spec)\.|\.(log|tmp|temp|tsbuildinfo|cpuprofile|prof|map)$'
	}
	return $Entry.Name -match $temporaryArtifactPattern -or $Entry.Name -match '\.(log|tmp|temp|tsbuildinfo|cpuprofile|prof|map)$'
}
$temporaryEntries = @(Get-ChildItem -LiteralPath $staging -Force -Recurse | Where-Object {
	Test-RuntimeArtifact $_
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
	Test-RuntimeArtifact $_
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
if (Test-Path -LiteralPath (Join-Path $runtime "node.exe")) {
	throw "Packaging contains a duplicate Node runtime instead of sharing Electron."
}
foreach ($packageDirectory in Get-ChildItem -LiteralPath (Join-Path $runtime "packages") -Directory) {
	if (Test-Path -LiteralPath (Join-Path $packageDirectory.FullName "dist")) {
		throw "Source SDK package contains redundant compiled output: $($packageDirectory.Name)"
	}
}

$releaseVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot "desktop.json") -Raw | ConvertFrom-Json).version
[IO.File]::WriteAllText((Join-Path $staging "version.txt"), "$releaseVersion`n", $utf8NoBom)
Write-Output "Installer payload staged: $staging"
