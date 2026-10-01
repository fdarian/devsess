import AppKit
import SwiftUI

struct RunRow: View {
    let run: RunRecord
    let stopping: Bool
    let error: String?
    let claudeSessions: [ClaudeSession]
    var snapshotMode = false
    let stop: () -> Void
    let restart: (ServiceRecord) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                Text("\(run.projectName) — \((run.canonicalCwd as NSString).lastPathComponent)")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color(nsColor: .secondaryLabelColor))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                if !claudeSessions.isEmpty {
                    ClaudeSessionBadge(sessions: claudeSessions, snapshotMode: snapshotMode)
                }
            }
            .frame(height: 20)
            .padding(.horizontal, 9)
            ForEach(run.services.indices, id: \.self) { index in
                ServiceRow(service: run.services[index], run: run, stopping: stopping,
                    snapshotMode: snapshotMode, stop: stop, restart: { restart(run.services[index]) })
            }
            if let error {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(Color(nsColor: .systemRed))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 3)
            }
        }
    }
}
