import AppKit
import SwiftUI

struct TerminalGlyph: View {
    let idle: Bool

    var body: some View {
        Canvas { context, _ in
            var path = Path(roundedRect: CGRect(x: 1.5, y: 2.5, width: 12, height: 10), cornerRadius: 2.5)
            path.move(to: CGPoint(x: 4.6, y: 6))
            path.addLine(to: CGPoint(x: 6.6, y: 7.5))
            path.addLine(to: CGPoint(x: 4.6, y: 9))
            path.move(to: CGPoint(x: 8.4, y: 9.2))
            path.addLine(to: CGPoint(x: 10.6, y: 9.2))
            context.stroke(path, with: .color(Color.primary.opacity(idle ? 0.35 : 1)),
                           style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        }
        .frame(width: 15, height: 15)
        .accessibilityLabel(idle ? "No active devsess runs" : "Active devsess runs")
    }
}

enum MenuBarIcon {
    static func count(for activeRuns: Int, daemonDown: Bool) -> Int? {
        if daemonDown || activeRuns < 3 { return nil }
        return activeRuns
    }

    @MainActor static func image(idle: Bool) -> NSImage {
        let renderer = ImageRenderer(content: TerminalGlyph(idle: idle))
        renderer.scale = 2
        guard let image = renderer.nsImage else { preconditionFailure("Could not render menu bar icon") }
        image.isTemplate = true
        return image
    }
}
