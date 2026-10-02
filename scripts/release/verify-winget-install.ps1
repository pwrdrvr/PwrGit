param([Parameter(Mandatory = $true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$status = Get-Content (Join-Path $Directory 'distribution-status.json') -Raw | ConvertFrom-Json
$manifest = Join-Path $Directory "manifests/p/PwrDrvr/PwrGit/$($status.version)"
$installer = $status.assets | Where-Object name -Like '*-windows-x64-setup.exe'
if (@($installer).Count -ne 1) { throw 'Expected one Windows x64 installer' }
$download = Join-Path $env:RUNNER_TEMP $installer.name
Invoke-WebRequest $installer.url -OutFile $download
if ("sha256:$((Get-FileHash $download -Algorithm SHA256).Hash.ToLower())" -ne $installer.digest) {
  throw 'Windows installer checksum mismatch'
}
$signature = Get-AuthenticodeSignature $download
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=PwrDrvr LLC') {
  throw "Invalid installer signature: $($signature.Status), $($signature.SignerCertificate.Subject)"
}

winget validate --manifest $manifest
if ($LASTEXITCODE -ne 0) { throw 'WinGet manifest validation failed' }
winget settings --enable LocalManifestFiles
if ($LASTEXITCODE -ne 0) { throw 'Could not enable local manifest installation' }
winget source update --name winget
if ($LASTEXITCODE -ne 0) { throw 'WinGet source refresh failed' }
# For initial registration there is no previous indexed package to upgrade.
# Once registered, test the indexed older version before installing the new one.
if ($status.winget.version -and $status.winget.version -ne $status.version) {
  winget install --id PwrDrvr.PwrGit --exact --source winget --version $status.winget.version --scope user --silent --accept-source-agreements --accept-package-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw 'Previous package is not installable from the public index; investigate propagation' }
}
winget install --manifest $manifest --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
if ($LASTEXITCODE -ne 0) { throw 'WinGet install/upgrade failed' }
$entries = @(Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/*' | Where-Object DisplayName -EQ PwrGit)
if ($entries.Count -ne 1 -or $entries[0].DisplayVersion -ne $status.version -or $entries[0].Publisher -ne 'PwrDrvr LLC') {
  throw 'Unexpected per-user Add/Remove Programs metadata'
}
# electron-builder stores InstallLocation in HKCU/Software/<app GUID>,
# separately from the Add/Remove Programs entry under Uninstall/<app GUID>.
$installationKey = Join-Path 'HKCU:/Software' $entries[0].PSChildName
$installLocation = (Get-ItemProperty -LiteralPath $installationKey -Name InstallLocation).InstallLocation
if ([string]::IsNullOrWhiteSpace($installLocation)) { throw 'Missing per-user installation directory' }
$app = Join-Path $installLocation 'PwrGit.exe'
if (-not (Test-Path -LiteralPath $app -PathType Leaf)) { throw "Installed executable is missing: $app" }
$appSignature = Get-AuthenticodeSignature $app
if ($appSignature.Status -ne 'Valid' -or $appSignature.SignerCertificate.Subject -notmatch 'CN=PwrDrvr LLC') {
  throw 'Installed app signature is invalid'
}
# The NSIS bootstrapper is x86; the shipped app, which the manifest describes,
# must be x64. Inspect its PE machine rather than the bootstrapper's machine.
$bytes = [IO.File]::ReadAllBytes($app)
$pe = [BitConverter]::ToInt32($bytes, 0x3c)
if ([BitConverter]::ToUInt16($bytes, $pe + 4) -ne 0x8664) { throw 'Installed payload is not x64' }
$entries[0] | Select-Object DisplayName, DisplayVersion, Publisher, PSChildName,
  @{ Name = 'InstallLocation'; Expression = { $installLocation } } | ConvertTo-Json
# Limit source queries to winget so uninstall does not prompt for msstore agreements.
winget uninstall --name PwrGit --exact --source winget --silent --accept-source-agreements --disable-interactivity
if ($LASTEXITCODE -ne 0) { throw 'WinGet uninstall failed' }
Write-Output 'Verified manifest, Authenticode, user scope, installed version, x64 payload and uninstall.'
