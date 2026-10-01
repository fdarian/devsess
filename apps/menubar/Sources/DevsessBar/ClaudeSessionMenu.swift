import AppKit
import SwiftUI

struct ClaudeSessionMenu: NSViewRepresentable {
    let state: ClaudeBadgeState
    let image: NSImage

    func makeCoordinator() -> Coordinator { Coordinator(state: state) }

    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(image: image, target: context.coordinator, action: #selector(Coordinator.showMenu(_:)))
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.imageScaling = .scaleNone
        button.setAccessibilityRole(.popUpButton)
        return button
    }

    func updateNSView(_ button: NSButton, context: Context) {
        button.image = image
        context.coordinator.state = state
        button.setAccessibilityLabel(state.sessions.map { "\($0.title) — \($0.state.label)" }.joined(separator: "\n"))
    }

    @MainActor static func makeMenu(state: ClaudeBadgeState, target: AnyObject) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for session in state.open {
            let item = sessionItem(session, target: target)
            if session.state == .live {
                item.image = NSImage(size: NSSize(width: 6, height: 6), flipped: false) { rect in
                    NSColor.systemGreen.setFill()
                    NSBezierPath(ovalIn: rect).fill()
                    return true
                }
            }
            menu.addItem(item)
        }
        if !state.archived.isEmpty {
            if !state.open.isEmpty { menu.addItem(.separator()) }
            let header = NSMenuItem(title: "Archived", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            for session in state.archived { menu.addItem(sessionItem(session, target: target)) }
        }
        return menu
    }

    @MainActor private static func sessionItem(_ session: ClaudeSession, target: AnyObject) -> NSMenuItem {
        let item = NSMenuItem(title: session.title, action: #selector(Coordinator.openSession(_:)), keyEquivalent: "")
        item.target = target
        item.representedObject = session.continuationURL
        if session.state == .archived {
            item.attributedTitle = NSAttributedString(string: session.title, attributes: [
                .foregroundColor: NSColor.secondaryLabelColor,
                .font: NSFont.menuFont(ofSize: 0)
            ])
        }
        return item
    }

    @MainActor final class Coordinator: NSObject {
        var state: ClaudeBadgeState

        init(state: ClaudeBadgeState) { self.state = state }

        @objc func showMenu(_ sender: NSButton) {
            let menu = ClaudeSessionMenu.makeMenu(state: state, target: self)
            menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.minY - 2), in: sender)
        }

        @objc func openSession(_ sender: NSMenuItem) {
            guard let url = sender.representedObject as? URL else { preconditionFailure("Missing session URL") }
            NSWorkspace.shared.open(url)
        }
    }
}
