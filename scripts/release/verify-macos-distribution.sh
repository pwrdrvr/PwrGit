#!/usr/bin/env bash
set -euo pipefail
version="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.RUNNER_TEMP + "/distribution/distribution-status.json")).version')"
for arch in arm64 universal; do
  mount="$RUNNER_TEMP/mount-$arch"
  mkdir -p "$mount"
  trap 'hdiutil detach "$mount" || true' EXIT
  hdiutil attach "$RUNNER_TEMP/distribution/downloads/PwrGit-$version-$arch.dmg" -readonly -nobrowse -mountpoint "$mount"
  app="$mount/PwrGit.app"
  test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")" = "$version"
  test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Contents/Info.plist")" = com.pwrdrvr.pwrgit
  codesign --verify --deep --strict "$app"
  codesign -dv --verbose=2 "$app" 2>&1 | grep -q 'Authority=Developer ID Application: PwrDrvr LLC'
  spctl --assess --type execute --verbose=2 "$app"
  slices="$(lipo -archs "$app/Contents/MacOS/PwrGit")"
  if [ "$arch" = arm64 ]; then
    test "$slices" = arm64
  else
    echo "$slices" | grep -qw arm64
    echo "$slices" | grep -qw x86_64
  fi
  hdiutil detach "$mount"
  trap - EXIT
done
