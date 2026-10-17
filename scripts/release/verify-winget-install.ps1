param([Parameter(Mandatory = $true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$status = Get-Content (Join-Path $Directory 'distribution-status.json') -Raw | ConvertFrom-Json
$manifest = Join-Path $Directory "manifests/p/PwrDrvr/PwrGit/$($status.version)"
$installer = $status.assets | Where-Object name -Like '*-windows-x64-setup.exe'
if (@($installer).Count -ne 1) { throw 'Expected one Windows x64 installer' }
$download = Join-Path (Join-Path $Directory 'downloads') $installer.name
if (-not (Test-Path -LiteralPath $download -PathType Leaf)) { throw 'Verified Windows installer is missing; run the platform download step first' }
if ("sha256:$((Get-FileHash $download -Algorithm SHA256).Hash.ToLower())" -ne $installer.digest -or (Get-Item -LiteralPath $download).Length -ne $installer.size) {
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
# Validate production manifests, then install copies whose only URL is a
# loopback mirror of the hash-verified Actions artifact bytes. Never let
# WinGet fall back to public release URLs, including the previous version.
$ready = Join-Path $Directory 'winget-loopback-ready.json'
$mirrorScript = Join-Path $PSScriptRoot 'winget-loopback.mjs'
$mirror = Start-Process node -ArgumentList @("`"$mirrorScript`"", 'serve', "`"$Directory`"", "`"$ready`"") -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $Directory 'winget-mirror.log') -RedirectStandardError (Join-Path $Directory 'winget-mirror-error.log')
try {
  $deadline = (Get-Date).AddSeconds(15)
  while (-not (Test-Path -LiteralPath $ready)) {
    if ($mirror.HasExited -or (Get-Date) -gt $deadline) { throw 'Verified installer mirror did not start' }
    Start-Sleep -Milliseconds 100
  }
  if ($status.winget.version -and $status.winget.version -ne $status.version) {
    $previous = Join-Path $Directory "manifests/p/PwrDrvr/PwrGit/$($status.winget.version)"
    winget validate --manifest $previous
    if ($LASTEXITCODE -ne 0) { throw 'Previous production manifest validation failed' }
    $previousLocal = Join-Path $Directory "installation/manifests/p/PwrDrvr/PwrGit/$($status.winget.version)"
    winget install --manifest $previousLocal --scope user --silent --accept-source-agreements --accept-package-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) { throw 'Previous verified package install failed' }
  }
  $localManifest = Join-Path $Directory "installation/manifests/p/PwrDrvr/PwrGit/$($status.version)"
  winget validate --manifest $localManifest
  if ($LASTEXITCODE -ne 0) { throw 'Installation-only manifest validation failed' }
  winget install --manifest $localManifest --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity --verbose-logs
  if ($LASTEXITCODE -ne 0) { throw 'WinGet install/upgrade failed' }
} finally {
  Stop-Process -Id $mirror.Id -ErrorAction SilentlyContinue
  Get-Content (Join-Path $Directory 'winget-mirror.log')
  Get-Content (Join-Path $Directory 'winget-mirror-error.log')
}
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
