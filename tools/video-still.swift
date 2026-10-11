// One frame from a video as a JPEG, up to 960px, for build-seed.py's posters.
// Usage: swift tools/video-still.swift <video> <seconds> <out.jpg>
// Same moment the page uses for its own stills (1s in, or a quarter of the
// way through a short clip), so the form and the gallery show the same frame.
import AVFoundation
import AppKit

let args = CommandLine.arguments
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero
generator.maximumSize = CGSize(width: 960, height: 960)

let done = DispatchSemaphore(value: 0)
var failed = false
Task {
  do {
    let duration = try await asset.load(.duration).seconds
    let seconds = min(Double(args[2]) ?? 1, duration / 4)
    let (image, _) = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
    let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.82])!
    try jpeg.write(to: URL(fileURLWithPath: args[3]))
  } catch {
    failed = true
  }
  done.signal()
}
done.wait()
exit(failed ? 1 : 0)
