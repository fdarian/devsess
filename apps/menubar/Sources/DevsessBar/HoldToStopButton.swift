import SwiftUI

struct HoldToStopButton: View {
    let action: () -> Void
    @LegacyState private var started: Date?
    @LegacyState private var fired = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: started == nil)) { timeline in
            let progress = started.map { min(1, timeline.date.timeIntervalSince($0) / 0.6) } ?? 0
            ZStack {
                Circle().stroke(Color.secondary.opacity(0.25), lineWidth: 2)
                Circle().trim(from: 0, to: progress).stroke(Theme.red, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Image(systemName: "stop.fill").font(.system(size: 9))
            }
            .frame(width: 24, height: 24)
            .foregroundStyle(.secondary)
            .contentShape(Rectangle())
            .onChange(of: progress) { _, value in
                if value >= 1 && !fired {
                    fired = true
                    started = nil
                    action()
                }
            }
        }
        .onLongPressGesture(minimumDuration: 0.6, maximumDistance: 30, pressing: { pressing in
            if pressing { started = Date(); fired = false }
            else { started = nil }
        }, perform: {
            if !fired { fired = true; action() }
        })
        .simultaneousGesture(TapGesture().modifiers(.option).onEnded { action() })
        .help("Hold to stop. Option-click to stop immediately.")
        .accessibilityLabel("Hold to stop run")
    }
}
