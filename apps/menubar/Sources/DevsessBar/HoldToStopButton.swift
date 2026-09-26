import SwiftUI

struct HoldToStopButton: View {
    let action: () -> Void
    @LegacyState private var started: Date?
    @LegacyState private var fired = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: started == nil)) { timeline in
            let progress = started.map { min(1, timeline.date.timeIntervalSince($0) / 0.6) } ?? 0
            ZStack {
                if started != nil {
                    Circle().trim(from: 0, to: progress)
                        .stroke(Theme.red, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .frame(width: 19, height: 19)
                }
                Image(systemName: "stop")
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(.secondary.opacity(0.7))
            }
            .frame(width: 22, height: 22)
            .contentShape(Rectangle())
        }
        .onLongPressGesture(minimumDuration: 0.6, maximumDistance: 30, pressing: { pressing in
            if pressing { started = Date(); fired = false }
            else { started = nil }
        }, perform: {
            fireOnce()
        })
        .simultaneousGesture(TapGesture().modifiers(.option).onEnded { fireOnce() })
        .help("Hold to stop. Option-click to stop immediately.")
        .accessibilityLabel("Hold to stop run")
    }

    private func fireOnce() {
        guard !fired else { return }
        fired = true
        started = nil
        action()
    }
}
