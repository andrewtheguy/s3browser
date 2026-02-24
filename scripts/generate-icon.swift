#!/usr/bin/env swift
// Converts an SVG file to a 1024x1024 PNG using NSImage.
import Cocoa

let args = CommandLine.arguments
guard args.count >= 3 else {
    fputs("Usage: generate-icon <input.svg> <output.png>\n", stderr)
    exit(1)
}

let inputPath = args[1]
let outputPath = args[2]

guard let svgData = FileManager.default.contents(atPath: inputPath) else {
    fputs("Cannot read: \(inputPath)\n", stderr)
    exit(1)
}

guard let svgImage = NSImage(data: svgData) else {
    fputs("Failed to parse SVG\n", stderr)
    exit(1)
}

let size = 1024
let targetSize = NSSize(width: size, height: size)

let bitmapRep = NSBitmapImageRep(
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
)!

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmapRep)
svgImage.draw(in: NSRect(origin: .zero, size: targetSize))
NSGraphicsContext.restoreGraphicsState()

guard let pngData = bitmapRep.representation(using: .png, properties: [:]) else {
    fputs("Failed to create PNG data\n", stderr)
    exit(1)
}

let url = URL(fileURLWithPath: outputPath)
do {
    try pngData.write(to: url)
} catch {
    fputs("Failed to write PNG: \(error)\n", stderr)
    exit(1)
}

print("Generated \(size)x\(size) icon: \(outputPath)")
