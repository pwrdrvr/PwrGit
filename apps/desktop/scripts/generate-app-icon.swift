#!/usr/bin/env swift

import AppKit
import Foundation

// Regenerates the PwrGit app-icon assets under apps/desktop/build/. Mirrors
// PwrSnap's generate-app-icon.swift: same warm near-black tile and the same
// deviceRGB accent, with the PwrGit lineage mark (a commit trunk plus one
// dimmed branch) in place of PwrSnap's stacked frames.
//
//   swift scripts/generate-app-icon.swift build
//
//   build/icon.icon/          Icon Composer package — the ONLY macOS input.
//     icon.json               background fill + one glyph layer
//     Assets/glyph.png        the mark alone, 1024×1024, transparent
//   build/icon.png            1024×1024 unpadded master (Windows/Linux source)
//   build/icon-macos.png      1024×1024 with the tile inset to Apple's 824px
//                             legacy safe area — the DEVELOPMENT Dock icon only
//
// electron-builder (`mac.icon: build/icon.icon`) compiles the package with
// Xcode 26's actool into Contents/Resources/Assets.car + CFBundleIconName
// (what macOS 26 draws) AND derives the legacy Contents/Resources/icon.icns +
// CFBundleIconFile (macOS 15 and earlier) from the same source. There is
// deliberately no hand-built .icns / .iconset any more: a macOS 26 build
// that only finds a legacy .icns guesses at how to normalize it, and 26.6.2
// guessed a light plate behind our padded tile (#187 added the padding).
// See AGENTS.md "macOS app icon".

let buildDir = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "build")

struct Color {
  // Warm near-black vertical gradient shared with PwrAgent / PwrSnap, as
  // 0-255 device-RGB endpoints (image top = lighter, bottom = near-black).
  // Interpolated per scanline in encoded space below — NSGradient would
  // interpolate in linear light and render the upper half too bright.
  static let bgTop: (r: Double, g: Double, b: Double) = (30, 26, 20)
  static let bgBottom: (r: Double, g: Double, b: Double) = (10, 9, 8)
  // Accent orange — the sibling app-icon accent, rgb(232,116,58) / #e8743a.
  // Pinned in deviceRGB so output pixels land on that exact value.
  static let accent = NSColor(deviceRed: 232 / 255.0, green: 116 / 255.0, blue: 58 / 255.0, alpha: 1)
  // Dimmed tier for the side branch — the same hue at 55%, matching the
  // "other people's lanes are greyed" default of the lineage view. Applied as
  // a transparency-layer alpha, not a per-stroke alpha, so the arc and the
  // branch ring don't double up where they overlap.
  static let dimAlpha: CGFloat = 0.55
}

/// Renders the icon at `size` px.
///
/// - `macOSCanvas`: inset the tile to Apple's legacy 824-in-1024 safe area
///   (a 100px transparent margin). Pre-26 macOS draws a .icns canvas
///   literally, so a full-bleed tile reads ~24% larger than Terminal next to
///   it. Used for the development Dock PNG only — the shipped legacy .icns
///   is derived by actool from the .icon package, which pads it itself.
/// - `glyphOnly`: skip the tile and paint just the mark on a transparent
///   canvas. This is the Icon Composer layer; the tile comes from the
///   package's `fill`, which is what lets macOS 26 apply its own shape,
///   glass edge, and Dark / Clear / Tinted variants.
func renderIcon(size: Int, macOSCanvas: Bool = false, glyphOnly: Bool = false) -> NSBitmapImageRep {
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: size,
    pixelsHigh: size,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else { fatalError("Unable to create bitmap") }
  bitmap.size = NSSize(width: CGFloat(size), height: CGFloat(size))

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

  let s = CGFloat(size)
  let canvasScale = s / 1024.0
  let tileInset = macOSCanvas ? 100 * canvasScale : 0
  let tileSize = macOSCanvas ? 824 * canvasScale : s
  let scale = tileSize / 1024.0
  func k(_ v: CGFloat) -> CGFloat { v * scale }
  func coord(_ v: CGFloat) -> CGFloat { tileInset + k(v) }

  if !glyphOnly {
    // Rounded-rect background — vertical gradient filled per scanline in
    // device-RGB (encoded) space so the ramp is linear in the output pixels.
    // The bitmap context is y-up, so image row 0 (top, lighter) maps to the
    // highest AppKit y.
    let cornerRadius = macOSCanvas ? 185 * canvasScale : k(180)
    let bg = NSBezierPath(roundedRect: NSRect(
                            x: tileInset,
                            y: tileInset,
                            width: tileSize,
                            height: tileSize),
                          xRadius: cornerRadius, yRadius: cornerRadius)
    NSGraphicsContext.saveGraphicsState()
    bg.addClip()
    let rows = max(1, Int(tileSize.rounded(.up)))
    for row in 0..<rows {
      let t = rows > 1 ? Double(row) / Double(rows - 1) : 0
      let r = (Color.bgTop.r + (Color.bgBottom.r - Color.bgTop.r) * t) / 255.0
      let g = (Color.bgTop.g + (Color.bgBottom.g - Color.bgTop.g) * t) / 255.0
      let b = (Color.bgTop.b + (Color.bgBottom.b - Color.bgTop.b) * t) / 255.0
      NSColor(deviceRed: CGFloat(r), green: CGFloat(g), blue: CGFloat(b), alpha: 1).setFill()
      NSRect(
        x: tileInset,
        y: tileInset + tileSize - CGFloat(row) - 1,
        width: tileSize,
        height: 1
      ).fill()
    }
    NSGraphicsContext.restoreGraphicsState()
  }

  // PwrGit mark — authored in a 1024 box, AppKit y-up.
  // Trunk at x=352 with a commit node at each end; one branch peels off the
  // trunk and rises to its own node at the right, drawn at 55% so the mark
  // reads "your lane bright, the other lane dimmed".
  let strokeWidth = k(56)
  let nodeRadius = k(84)

  func ring(_ cx: CGFloat, _ cy: CGFloat, _ color: NSColor) {
    let p = NSBezierPath(ovalIn: NSRect(x: coord(cx) - nodeRadius, y: coord(cy) - nodeRadius,
                                        width: nodeRadius * 2, height: nodeRadius * 2))
    p.lineWidth = strokeWidth
    color.setStroke()
    p.stroke()
  }

  // Branch arc + branch node (dim). Both go into one transparency layer so
  // the composite is a flat 55% — overlapping strokes inside the layer stay
  // opaque relative to each other instead of compounding into a darker patch.
  let cg = NSGraphicsContext.current!.cgContext
  cg.setAlpha(Color.dimAlpha)
  cg.beginTransparencyLayer(auxiliaryInfo: nil)
  let branch = NSBezierPath()
  branch.move(to: NSPoint(x: coord(352), y: coord(424)))
  branch.curve(to: NSPoint(x: coord(588), y: coord(620)),
               controlPoint1: NSPoint(x: coord(352), y: coord(554)),
               controlPoint2: NSPoint(x: coord(470), y: coord(620)))
  branch.lineWidth = strokeWidth
  branch.lineCapStyle = .round
  Color.accent.setStroke()
  branch.stroke()
  ring(672, 620, Color.accent)
  cg.endTransparencyLayer()
  cg.setAlpha(1)

  // Trunk (full)
  let trunk = NSBezierPath()
  trunk.move(to: NSPoint(x: coord(352), y: coord(384)))
  trunk.line(to: NSPoint(x: coord(352), y: coord(640)))
  trunk.lineWidth = strokeWidth
  trunk.lineCapStyle = .round
  Color.accent.setStroke()
  trunk.stroke()
  ring(352, 724, Color.accent)
  ring(352, 300, Color.accent)

  NSGraphicsContext.restoreGraphicsState()
  return bitmap
}

func writePNG(_ rep: NSBitmapImageRep, to url: URL, label: String) throws {
  guard let data = rep.representation(using: .png, properties: [:]) else {
    fatalError("Unable to create PNG for \(label)")
  }
  try data.write(to: url)
  print("  \(label) (\(rep.pixelsWide)x\(rep.pixelsHigh))")
}

/// One gradient stop in Icon Composer's `srgb:r,g,b,a` notation. The
/// fixed five-decimal format keeps `icon.json` byte-for-byte deterministic.
func gradientStop(_ c: (r: Double, g: Double, b: Double)) -> String {
  String(format: "srgb:%.5f,%.5f,%.5f,1.00000", c.r / 255.0, c.g / 255.0, c.b / 255.0)
}

// --- build/icon.icon — the Icon Composer package ---------------------------
//
// The schema is the one Icon Composer writes (compare Ghostty's
// images/Ghostty.icon/icon.json, MIT). `fill` paints the whole icon shape;
// the single layer is the mark with `fill: automatic` so Dark / Clear /
// Tinted appearances can recolor it. `glass: false` keeps the mark a flat
// stroke — only the tile edge picks up the macOS 26 glass treatment.
let iconPackage = buildDir.appendingPathComponent("icon.icon")
let assetsDir = iconPackage.appendingPathComponent("Assets")
try FileManager.default.createDirectory(at: assetsDir, withIntermediateDirectories: true)

try writePNG(
  renderIcon(size: 1024, glyphOnly: true),
  to: assetsDir.appendingPathComponent("glyph.png"),
  label: "icon.icon/Assets/glyph.png"
)

let iconJSON = """
{
  "fill" : {
    "linear-gradient" : [
      "\(gradientStop(Color.bgTop))",
      "\(gradientStop(Color.bgBottom))"
    ]
  },
  "groups" : [
    {
      "name" : "Mark",
      "layers" : [
        {
          "name" : "glyph",
          "image-name" : "glyph.png",
          "fill" : "automatic",
          "glass" : false,
          "hidden" : false,
          "blend-mode" : "normal"
        }
      ],
      "lighting" : "individual",
      "shadow" : {
        "kind" : "neutral",
        "opacity" : 0.5
      },
      "translucency" : {
        "enabled" : false,
        "value" : 0.5
      }
    }
  ],
  "supported-platforms" : {
    "circles" : [
      "watchOS"
    ],
    "squares" : "shared"
  }
}

"""
try iconJSON.write(to: iconPackage.appendingPathComponent("icon.json"), atomically: true, encoding: .utf8)
print("  icon.icon/icon.json")

// --- build/icon.png — unpadded master (Windows / Linux source) --------------
try writePNG(
  renderIcon(size: 1024),
  to: buildDir.appendingPathComponent("icon.png"),
  label: "icon.png"
)

// --- build/icon-macos.png — development Dock icon ---------------------------
//
// `app.dock.setIcon()` in development paints this PNG literally, with none
// of the packaged-app icon handling, so it carries the legacy safe-area
// inset itself (see src/main/index.ts).
try writePNG(
  renderIcon(size: 1024, macOSCanvas: true),
  to: buildDir.appendingPathComponent("icon-macos.png"),
  label: "icon-macos.png"
)

print("Generated app-icon assets in \(buildDir.path)")
