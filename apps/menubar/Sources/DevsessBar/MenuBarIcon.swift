import AppKit
import SwiftUI

struct JackGlyph: View {
    let states: [JackState]
    let daemonDown: Bool

    var body: some View {
        Canvas { context, size in
            var visible = states.count >= 5 ? Array(states.prefix(3)) : states
            if states.count >= 5 && states.contains(.failed) && !visible.contains(.failed) {
                visible[2] = .failed
            }
            let count = visible.isEmpty ? 1 : visible.count
            let radius: CGFloat = 4.1
            for index in 0..<count {
                let x = CGFloat(index) * 12 + 6
                let center = CGPoint(x: x, y: size.height / 2)
                let circle = Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
                let state = visible.isEmpty ? JackState.starting : visible[index]
                let tint = state == .failed ? Color(nsColor: .systemRed) : Color.primary
                if states.isEmpty {
                    context.stroke(circle, with: .color(tint.opacity(daemonDown ? 0.5 : 1)), style: StrokeStyle(lineWidth: 1.5, dash: [2, 2]))
                } else if state == .ready {
                    context.fill(circle, with: .color(tint))
                } else {
                    context.stroke(circle, with: .color(tint), lineWidth: 1.6)
                    if state == .failed {
                        var slash = Path()
                        slash.move(to: CGPoint(x: x - 5.3, y: center.y + 5.3))
                        slash.addLine(to: CGPoint(x: x + 5.3, y: center.y - 5.3))
                        context.stroke(slash, with: .color(tint), lineWidth: 1.6)
                    }
                }
            }
            if states.count >= 5 {
                let text = Text("\(states.count)").font(.system(size: 10, weight: .semibold, design: .rounded))
                context.draw(text, at: CGPoint(x: size.width - 7, y: size.height / 2))
            }
        }
        .frame(width: states.count >= 5 ? 52 : CGFloat(max(1, min(states.count, 4))) * 12, height: 18)
        .accessibilityLabel(states.isEmpty ? "No active devsess runs" : "\(states.count) active devsess runs")
    }
}

enum MenuBarIcon {
    @MainActor static func image(states: [JackState], daemonDown: Bool) -> NSImage {
        let view = JackGlyph(states: states, daemonDown: daemonDown)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.nsImage else { preconditionFailure("Could not render menu bar icon") }
        image.isTemplate = !states.contains(.failed)
        return image
    }
}
