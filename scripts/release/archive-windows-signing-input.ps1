[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Git for Windows' tar follows pnpm workspace junctions. The Windows release
# stage is deliberately hoisted so this virtual-root directory must not exist;
# otherwise archiving can recurse back into the workspace indefinitely.
$workspaceLinkRoot = "apps/desktop/release-stage/node_modules/.pnpm/node_modules"
if (Test-Path -LiteralPath $workspaceLinkRoot) {
  throw "Windows release-stage must not contain $workspaceLinkRoot; archive only the hoisted signing input."
}

$archiveInputs = @(
  "apps/desktop/release-stage",
  "apps/desktop/scripts/release.mjs",
  "apps/desktop/scripts/verify-asar-contents.mjs",
  "apps/desktop/scripts/verify-embedded-git-notices.mjs",
  "scripts/release/install-trusted-signing.ps1"
)
foreach ($archiveInput in $archiveInputs) {
  if (-not (Test-Path -LiteralPath $archiveInput)) {
    throw "Required Windows signing input is missing: $archiveInput"
  }
}

& tar.exe -czf $ArchivePath @archiveInputs
if ($LASTEXITCODE -ne 0) {
  throw "Failed to archive Windows signing input (exit code $LASTEXITCODE)."
}
