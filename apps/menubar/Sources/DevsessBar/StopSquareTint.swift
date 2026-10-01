import SwiftUI

enum StopSquareTintGeometry {
    static let size: CGFloat = 20
    static let cornerRadius: CGFloat = 5

    static func frame(centeredOn square: CGRect) -> CGRect {
        CGRect(x: square.midX - size / 2, y: square.midY - size / 2, width: size, height: size)
    }
}

private struct StopSquareTint: ViewModifier {
    let armed: Bool

    func body(content: Content) -> some View {
        content.background(alignment: .center) {
            RoundedRectangle(cornerRadius: StopSquareTintGeometry.cornerRadius)
                .fill(armed ? Color(nsColor: .systemRed).opacity(0.15) : .clear)
                .frame(width: StopSquareTintGeometry.size, height: StopSquareTintGeometry.size)
                .allowsHitTesting(false)
        }
    }
}

extension View {
    func stopSquareTint(armed: Bool) -> some View {
        modifier(StopSquareTint(armed: armed))
    }
}
