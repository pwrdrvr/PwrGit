repo: pwrdrvr/PwrSnap
branch: main
path: apps/desktop

Reference repo only — PwrSnap is the sibling app whose release-asset system
PwrGit's icon set was built to match. Nothing here is synced back to PwrSnap.
Target repo for the produced assets: pwrdrvr/PwrGit, `apps/desktop/build/`.

## Last sync
date: 2026-08-02T02:29:44Z

### Updated in this project
- Read PwrSnap's `generate-app-icon.swift`, `generate-tray-icon.mjs`, `generate-dmg-background.swift`, and `electron-builder.yml` as the asset contract.
- Authored the PwrGit lineage mark and generated the full sibling-style asset set under `apps/desktop/build/`.
- Ported all three generator scripts to PwrGit under `apps/desktop/scripts/`.
- Copied `build/fonts/Geist-Bold.ttf` (used by the DMG generator).

## Screen map
| Output | Built from |
|---|---|
| apps/desktop/build/icon.png, icon.icns, icon.iconset/* | PwrSnap apps/desktop/scripts/generate-app-icon.swift |
| apps/desktop/build/tray-icon*.png | PwrSnap apps/desktop/scripts/generate-tray-icon.mjs |
| apps/desktop/build/dmg-background.png | PwrSnap apps/desktop/scripts/generate-dmg-background.swift |
| apps/desktop/build/README.md (wiring) | PwrSnap apps/desktop/electron-builder.yml |
