# PwrGit release assets

Generated to match the PwrSnap / PwrAgent asset system. Everything here is
regenerable from the two scripts in `apps/desktop/scripts/`.

## The mark

A lineage rail: a commit trunk with a node at each end, plus one branch that
peels off and rises to its own node, drawn at 55% opacity. Same construction
logic as the sibling marks (one geometric idea, one accent, opacity for
depth) and it reads as the app's LINEAGE column — bright lane is yours, dim
lane is everyone else's.

- Design-system SVG: `assets/logo-pwrgit.svg` (128 viewBox, `currentColor`)
- App-icon accent: `#e8743a` (sibling app-icon orange)
- Tray / DMG accent: `#ff8a1f` (design-system tangerine)
- Tile: 180/1024 corner radius on Windows/Linux (`icon.png`); the development
  Dock icon (`icon-macos.png`) uses Apple's legacy 824/1024 tile with a 100px
  margin and 185px corner radius. Both use the vertical gradient
  `rgb(30,26,20)` → `rgb(10,9,8)`. The shipped macOS icon bakes no tile at
  all: `icon.icon/` carries the mark alone and that gradient as the package
  `fill`, and macOS draws its own shape around it.

## Files

```
apps/desktop/build/
  icon.png                       1024×1024   Windows/Linux source
  icon-macos.png                 1024×1024   macOS safe-area development Dock icon
  icon.icon/                                 Icon Composer package — the macOS input
    icon.json                                fill gradient + one glyph layer
    Assets/glyph.png             1024×1024   the mark alone, transparent
  dmg-background.png             660×400
  tray-icon-template.png         16×16       macOS menubar (alpha-only)
  tray-icon-template@2x.png      32×32
  tray-icon-template@3x.png      48×48
  tray-icon.png                  16×16       Windows / Linux (tangerine)
  tray-icon@2x.png               32×32
  tray-icon@3x.png               48×48
  fonts/Geist-Bold.ttf                       used by the DMG generator
```

There is no `.icns` or `.iconset` in the repo any more. electron-builder
compiles `icon.icon/` with Xcode 26's `actool` at package time into
`Contents/Resources/Assets.car` (what macOS 26 draws) and derives the legacy
`icon.icns` (macOS 15 and earlier) from it — see AGENTS.md "macOS app icon"
for why a hand-built `.icns` is not an option. Regenerate on a Mac:

```
swift scripts/generate-app-icon.swift build
node scripts/generate-tray-icon.mjs
swift scripts/generate-dmg-background.swift build/dmg-background.png
```

No hand-authored `.ico` — electron-builder derives the Windows icon from the
1024px `build/icon.png`, same as the siblings.

## electron-builder wiring

The DMG geometry PwrGit already has (660×400 window, 112px icons, app at
170,230 and Applications at 500,230) is what the background art was drawn
against — don't move it without regenerating the PNG.

```yaml
mac:
  icon: build/icon.icon   # Icon Composer package; actool derives the .icns

win:
  icon: build/icon.png

dmg:
  background: build/dmg-background.png
  window: { width: 660, height: 400 }
  iconSize: 112
  contents:
    - { x: 170, y: 230, type: file }
    - { x: 500, y: 230, type: link, path: /Applications }

extraResources:
  - { from: "build/tray-icon-template.png",    to: "tray-icon-template.png" }
  - { from: "build/tray-icon-template@2x.png", to: "tray-icon-template@2x.png" }
  - { from: "build/tray-icon-template@3x.png", to: "tray-icon-template@3x.png" }
  - { from: "build/tray-icon.png",             to: "tray-icon.png" }
  - { from: "build/tray-icon@2x.png",          to: "tray-icon@2x.png" }
  - { from: "build/tray-icon@3x.png",          to: "tray-icon@3x.png" }
```
