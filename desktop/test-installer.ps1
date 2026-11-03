param([Parameter(Mandatory = $true)][string]$Installer)

$ErrorActionPreference = "Stop"
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$appKey = "HKCU:/Software/AllWeave/Build"
$uninstallKey = "HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/AllWeaveBuild"
$shortcuts = @(
	(Join-Path ([Environment]::GetFolderPath('Desktop')) "AllWeave Build.lnk"),
	(Join-Path ([Environment]::GetFolderPath('Programs')) "AllWeave Build.lnk")
)
if ((Test-Path $appKey) -or (Test-Path $uninstallKey) -or @($shortcuts | Where-Object { Test-Path -LiteralPath $_ }).Count) {
	throw "Run installer smoke tests on a user profile without an existing AllWeave Build installation or shortcuts."
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ("AllWeave 安装测试 " + [guid]::NewGuid().ToString("N"))
$application = $null
try {
	$setup = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$fixture") -PassThru -Wait -WindowStyle Hidden
	if ($setup.ExitCode -ne 0) { throw "Initial installation failed: $($setup.ExitCode)" }
	Write-Output "Initial installation completed."
	$installedVersion = (Get-Content -LiteralPath (Join-Path $fixture "version.txt") -Raw).Trim()
	if ((Get-ItemProperty $uninstallKey).DisplayVersion -ne $installedVersion) { throw "Installed version differs from registry." }
	if ((Get-Item -LiteralPath $Installer).VersionInfo.ProductVersion -ne $installedVersion) { throw "Installer version differs from installed version." }
	$expectedUninstall = '"' + (Join-Path $fixture "Uninstall.exe") + '"'
	if ((Get-ItemProperty $uninstallKey).UninstallString -ne $expectedUninstall) { throw "Windows uninstall command is invalid." }
	foreach ($shortcut in $shortcuts) {
		if (-not (Test-Path -LiteralPath $shortcut)) { throw "Shortcut missing: $shortcut" }
	}
	New-Item -ItemType Directory -Path (Join-Path $fixture "data") -Force | Out-Null
	[IO.File]::WriteAllText((Join-Path $fixture "data/upgrade-sentinel.txt"), "preserve sessions and credentials")
	[IO.File]::WriteAllText((Join-Path $fixture "workspaces/project.txt"), "preserve user project")
	$roots = "# preserve custom workspace configuration`nworkspaces`n"
	[IO.File]::WriteAllText((Join-Path $fixture "workspace-roots.txt"), $roots)
	New-Item -ItemType Directory -Path (Join-Path $fixture "runtime") -Force | Out-Null
	[IO.File]::WriteAllText((Join-Path $fixture "runtime/stale-file.txt"), "remove obsolete Node runtime")
	Set-ItemProperty $uninstallKey -Name DisplayVersion -Value "0.0.1"
	$setup = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
	if ($setup.ExitCode -ne 0) { throw "Upgrade failed: $($setup.ExitCode)" }
	if (Test-Path -LiteralPath (Join-Path $fixture "runtime/stale-file.txt")) { throw "Upgrade retained obsolete runtime files." }
	if (-not (Test-Path -LiteralPath (Join-Path $fixture "shell/AllWeaveBuild.exe"))) { throw "Upgrade did not install the shared Electron runtime." }
	if (Test-Path -LiteralPath (Join-Path $fixture "runtime/node.exe")) { throw "Upgrade retained a duplicate Node runtime." }
	if ([IO.File]::ReadAllText((Join-Path $fixture "workspace-roots.txt")) -ne $roots) { throw "Upgrade overwrote workspace configuration." }
	Write-Output "Upgrade and workspace preservation passed."
	Set-ItemProperty $uninstallKey -Name DisplayVersion -Value "65535.0.0"
	$setup = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
	if ($setup.ExitCode -eq 0) { throw "Downgrade was accepted." }
	Set-ItemProperty $uninstallKey -Name DisplayVersion -Value $installedVersion
	Write-Output "Downgrade rejection passed."

	$application = Start-Process -FilePath (Join-Path $fixture "shell/AllWeaveBuild.exe") -PassThru -WindowStyle Hidden
	$database = Join-Path $fixture "data/console.sqlite"
	$deadline = [DateTime]::UtcNow.AddSeconds(180)
	while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $database)) {
		if ($application.HasExited) { throw "Desktop application exited during startup: $($application.ExitCode)" }
		Start-Sleep -Milliseconds 250
	}
	if (-not (Test-Path -LiteralPath $database)) { throw "Desktop service did not initialize its database." }
	if (-not (Test-Path -LiteralPath (Join-Path $fixture "shell/node.exe"))) {
		throw "The installed application did not initialize its shared Node runtime."
	}
	$application.CloseMainWindow() | Out-Null
	if (-not $application.WaitForExit(10000)) {
		& taskkill.exe /PID $application.Id /T /F | Out-Null
		$application.WaitForExit()
	}
	$application.Dispose()
	$application = $null
	Write-Output "Desktop startup and bundled Node runtime checks passed."

	# Hold the executable open as Windows does while it is running.
	$lock = [IO.File]::Open((Join-Path $fixture "shell/AllWeaveBuild.exe"), 'Open', 'Read', 'Read')
	try {
		$setup = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
		if ($setup.ExitCode -eq 0) { throw "Upgrade ignored the running application lock." }
	} finally { $lock.Dispose() }
	Write-Output "Running application rejection passed."

	$uninstaller = Join-Path $fixture "Uninstall.exe"
	$uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$fixture") -PassThru -Wait -WindowStyle Hidden
	if ($uninstall.ExitCode -ne 0) { throw "Uninstall failed: $($uninstall.ExitCode)" }
	foreach ($path in @("data/upgrade-sentinel.txt", "workspaces/project.txt", "workspace-roots.txt")) {
		if (-not (Test-Path -LiteralPath (Join-Path $fixture $path))) { throw "User data was removed: $path" }
	}
	if ((Test-Path $appKey) -or (Test-Path $uninstallKey)) { throw "Uninstall retained registration." }
	if (Test-Path -LiteralPath (Join-Path $fixture "runtime")) { throw "Uninstall retained the former Node runtime." }
	Write-Output "Installer tests passed: install, Node service startup, upgrade, data retention, downgrade/running-app rejection and uninstall; Chinese paths with spaces."
} catch {
	Write-Error $_ -ErrorAction Continue
	throw
} finally {
	if ($application -and -not $application.HasExited) {
		$application.CloseMainWindow() | Out-Null
		if (-not $application.WaitForExit(10000)) {
			& taskkill.exe /PID $application.Id /T /F | Out-Null
			$application.WaitForExit()
		}
		$application.Dispose()
	}
	$registeredPath = (Get-ItemProperty $appKey -ErrorAction SilentlyContinue).InstallLocation
	if ($registeredPath -eq $fixture -and (Test-Path -LiteralPath (Join-Path $fixture "Uninstall.exe"))) {
		Start-Process -FilePath (Join-Path $fixture "Uninstall.exe") -ArgumentList @('/S', "_?=$fixture") -Wait -WindowStyle Hidden
	}
	$resolvedFixture = [IO.Path]::GetFullPath($fixture)
	$resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
	if (-not $resolvedFixture.StartsWith($resolvedTemp + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
		throw "Refusing to remove an installation outside the temporary directory."
	}
	for ($attempt = 0; $attempt -lt 10 -and (Test-Path -LiteralPath $resolvedFixture); $attempt++) {
		try { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force } catch {
			if ($attempt -eq 9) { Write-Warning "Test cleanup failed: $_" } else { Start-Sleep -Milliseconds 300 }
		}
	}
}
