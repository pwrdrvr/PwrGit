#!/usr/bin/env swift

import AppKit
import Foundation

// Temporary PwrGit brand mark. This deterministic source is intentionally
// easy to replace when Claude Design supplies the final artwork: retain the
// output sizes and packaging contract below, and swap only renderIcon().
let outputDir = CommandLine.arguments.dropFirst().first ?? "build/icon.iconset"

struct Color {
  // PwrGit's warm-charcoal application surfaces, interpolated in encoded
  // device RGB so the generated pixels match the product palette exactly.
  static let bgTop: (r: Double, g: Double, b: Double) = (26, 23, 20)
  static let bgBottom: (r: Double, g: Double, b: Double) = (10, 9, 8)
  // The graph colors are the first three lanes from PwrGit's commit graph.
  static let main = NSColor(deviceRed: 232 / 255.0, green: 116 / 255.0, blue: 58 / 255.0, alpha: 1)
  static let branchGreen = NSColor(deviceRed: 98 / 255.0, green: 200 / 255.0, blue: 130 / 255.0, alpha: 1)
  static let branchBlue = NSColor(deviceRed: 122 / 255.0, green: 162 / 255.0, blue: 247 / 255.0, alpha: 1)
}

func renderIcon(size: Int) -> NSBitmapImageRep {
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
  let scale = s / 1024.0

  // A macOS-style rounded icon tile. Fill the gradient one scanline at a
  // time in device RGB; NSGradient interpolates in linear light and would
  // otherwise drift from PwrGit's established warm-dark palette.
  let cornerRadius = 180 * scale
  let background = NSBezierPath(
    roundedRect: NSRect(x: 0, y: 0, width: s, height: s),
    xRadius: cornerRadius,
    yRadius: cornerRadius
  )
  NSGraphicsContext.saveGraphicsState()
  background.addClip()
  let rows = Int(s)
  for row in 0..<rows {
    let t = rows > 1 ? Double(row) / Double(rows - 1) : 0
    let r = (Color.bgTop.r + (Color.bgBottom.r - Color.bgTop.r) * t) / 255.0
    let g = (Color.bgTop.g + (Color.bgBottom.g - Color.bgTop.g) * t) / 255.0
    let b = (Color.bgTop.b + (Color.bgBottom.b - Color.bgTop.b) * t) / 255.0
    NSColor(deviceRed: CGFloat(r), green: CGFloat(g), blue: CGFloat(b), alpha: 1).setFill()
    NSRect(x: 0, y: s - CGFloat(row) - 1, width: s, height: 1).fill()
  }
  NSGraphicsContext.restoreGraphicsState()

  // Placeholder product mark: a compact, readable git graph. It uses the
  // same primary, green, and blue lane colors as the graph in the app so the
  // provisional icon feels native to PwrGit without borrowing another Pwr
  // product's mark.
  let strokeWidth = 58 * scale
  let nodeRadius = 67 * scale
  let mainX = 492 * scale
  let topY = 800 * scale
  let middleY = 512 * scale
  let bottomY = 232 * scale

  func stroke(_ path: NSBezierPath, color: NSColor) {
    path.lineWidth = strokeWidth
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    color.setStroke()
    path.stroke()
  }

  func node(x: CGFloat, y: CGFloat, color: NSColor) {
    color.setFill()
    NSBezierPath(
      ovalIn: NSRect(
        x: x - nodeRadius,
        y: y - nodeRadius,
        width: nodeRadius * 2,
        height: nodeRadius * 2
      )
    ).fill()
  }

  // Branches are drawn first so the tangerine trunk owns merge junctions.
  let blueBranch = NSBezierPath()
  blueBranch.move(to: NSPoint(x: 748 * scale, y: 726 * scale))
  blueBranch.curve(
    to: NSPoint(x: mainX, y: middleY),
    controlPoint1: NSPoint(x: 628 * scale, y: 726 * scale),
    controlPoint2: NSPoint(x: 650 * scale, y: middleY)
  )
  stroke(blueBranch, color: Color.branchBlue)

  let greenBranch = NSBezierPath()
  greenBranch.move(to: NSPoint(x: 268 * scale, y: 320 * scale))
  greenBranch.curve(
    to: NSPoint(x: mainX, y: bottomY),
    controlPoint1: NSPoint(x: 392 * scale, y: 320 * scale),
    controlPoint2: NSPoint(x: 352 * scale, y: bottomY)
  )
  stroke(greenBranch, color: Color.branchGreen)

  let trunk = NSBezierPath()
  trunk.move(to: NSPoint(x: mainX, y: topY))
  trunk.line(to: NSPoint(x: mainX, y: bottomY))
  stroke(trunk, color: Color.main)

  node(x: mainX, y: topY, color: Color.main)
  node(x: mainX, y: middleY, color: Color.main)
  node(x: mainX, y: bottomY, color: Color.main)
  node(x: 748 * scale, y: 726 * scale, color: Color.branchBlue)
  node(x: 268 * scale, y: 320 * scale, color: Color.branchGreen)

  NSGraphicsContext.restoreGraphicsState()
  return bitmap
}

// Apple's required iconset names. Keep this complete even though several
// sizes share pixel dimensions; iconutil uses the names to assign scale.
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
  let rep = renderIcon(size: size)
  guard let pngData = rep.representation(using: .png, properties: [:]) else {
    fatalError("Unable to create PNG for \(filename)")
  }
  let file = outputURL.appendingPathComponent(filename)
  try pngData.write(to: file)
  print("  \(filename) (\(size)x\(size))")
}

let dockIconRep = renderIcon(size: 1024)
guard let dockIconPngData = dockIconRep.representation(using: .png, properties: [:]) else {
  fatalError("Unable to create PNG for icon.png")
}
let dockIconFile = outputURL.deletingLastPathComponent().appendingPathComponent("icon.png")
try dockIconPngData.write(to: dockIconFile)
print("  icon.png (1024x1024)")

print("Generated \(sizes.count) icon variants in \(outputDir)")
