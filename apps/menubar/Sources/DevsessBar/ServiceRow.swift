import SwiftUI

struct ServiceRow: View {
    let service: ServiceRecord
    let active: Bool
    var snapshotMode = false
    let restart: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @LegacyState private var hovered = false
    @LegacyState private var breathing = false

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Circle()
                .fill(Theme.lamp(service.state))
                .frame(width: 8, height: 8)
                .opacity(service.state == .starting && !reduceMotion && breathing ? 0.45 : 1)
                .padding(.top, 5)
                .onAppear {
                    guard service.state == .starting && !reduceMotion else { return }
                    withAnimation(.easeInOut(duration: 1.3).repeatForever(autoreverses: true)) { breathing = true }
                }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 7) {
                    Text(service.name).font(.system(size: 12, weight: .medium))
                    if let url = service.publishedURL {
                        if snapshotMode {
                            Text(url.absoluteString)
                                .font(.system(size: 11))
                                .foregroundStyle(.tint)
                                .lineLimit(1)
                        } else {
                            Link(url.absoluteString, destination: url)
                                .font(.system(size: 11))
                                .lineLimit(1)
                        }
                    }
                    if let exitCode = service.exitCode {
                        Text("exit \(exitCode)").foregroundStyle(Theme.red)
                    } else if let signal = service.signal {
                        Text("signal \(signal)").foregroundStyle(Theme.red)
                    }
                    Spacer(minLength: 2)
                    if active && hovered {
                        Button(action: restart) { Image(systemName: "arrow.clockwise") }
                            .buttonStyle(.borderless)
                            .help("Restart \(service.name)")
                    }
                }
                Text(service.command)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(service.command)
            }
        }
        .onHover { hovered = $0 }
    }
}
