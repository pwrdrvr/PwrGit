#!/usr/bin/env swift

import AppKit
import Foundation

// Regenerates apps/desktop/build/icon.iconset/* and build/icon.png for PwrGit.
// Mirrors PwrSnap's generate-app-icon.swift: same warm near-black rounded-rect
// tile and the same deviceRGB accent, with the PwrGit lineage mark (a commit
// trunk plus one dimmed branch) in place of PwrSnap's stacked frames.
//
//   swift scripts/generate-app-icon.swift build/icon.iconset
//   iconutil -c icns build/icon.iconset -o build/icon.icns

let outputDir = CommandLine.arguments.dropFirst().first ?? "build/icon.iconset"

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

func renderIcon(size: Int, macOSCanvas: Bool = false) -> NSBitmapImageRep {
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

  // Rounded-rect background — vertical gradient filled per scanline in
  // device-RGB (encoded) space so the ramp is linear in the output pixels.
  // The bitmap context is y-up, so image row 0 (top, lighter) maps to the
  // highest AppKit y.
  // Legacy macOS renders the ICNS canvas literally. Apple's 1024px template
  // puts the rounded tile in an 824px square with a 100px transparent margin;
  // macOS 26 can normalize old icons automatically, but Sequoia and earlier
  // cannot. Keep the unpadded master for Windows/Linux and use this safe-area
  // canvas for the ICNS and the development Dock icon.
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

let sizes: [(Int, String)] = [
  (16, "icon_16x16.png"),
  (32, "icon_16x16@2x.png"),
  (32, "icon_32x32.png"),
  (64, "icon_32x32@2x.png"),
  (128, "icon_128x128.png"),
  (256, "icon_128x128@2x.png"),
  (256, "icon_256x256.png"),
  (512, "icon_256x256@2x.png"),
  (512, "icon_512x512.png"),
  (1024, "icon_512x512@2x.png"),
]

let outputURL = URL(fileURLWithPath: outputDir)
try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)

for (size, filename) in sizes {
  let rep = renderIcon(size: size, macOSCanvas: true)
  guard let pngData = rep.representation(using: .png, properties: [:]) else {
    fatalError("Unable to create PNG for \(filename)")
  }
  try pngData.write(to: outputURL.appendingPathComponent(filename))
  print("  \(filename) (\(size)x\(size))")
}

let dockIconRep = renderIcon(size: 1024)
guard let dockIconPngData = dockIconRep.representation(using: .png, properties: [:]) else {
  fatalError("Unable to create PNG for icon.png")
}
try dockIconPngData.write(to: outputURL.deletingLastPathComponent().appendingPathComponent("icon.png"))
print("  icon.png (1024x1024)")

let macOSDockIconRep = renderIcon(size: 1024, macOSCanvas: true)
guard let macOSDockIconPngData = macOSDockIconRep.representation(using: .png, properties: [:]) else {
  fatalError("Unable to create PNG for icon-macos.png")
}
try macOSDockIconPngData.write(
  to: outputURL.deletingLastPathComponent().appendingPathComponent("icon-macos.png")
)
print("  icon-macos.png (1024x1024)")

print("Generated \(sizes.count) icon variants in \(outputDir)")
