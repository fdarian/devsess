import SwiftUI

private struct ContentHeightKey: PreferenceKey {
    static var defaultValue: CGFloat { 0 }

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

struct FittingScrollView<Content: View>: View {
    let maxHeight: CGFloat
    @ViewBuilder let content: () -> Content
    @LegacyState private var contentHeight: CGFloat

    init(maxHeight: CGFloat, @ViewBuilder content: @escaping () -> Content) {
        self.maxHeight = maxHeight
        self.content = content
        _contentHeight = LegacyState(initialValue: maxHeight)
    }

    var body: some View {
        ScrollView(.vertical) {
            content()
                .background {
                    GeometryReader { geometry in
                        Color.clear.preference(key: ContentHeightKey.self, value: geometry.size.height)
                    }
                }
        }
        .frame(height: min(contentHeight, maxHeight))
        .onPreferenceChange(ContentHeightKey.self) { height in
            let next = min(height.rounded(.up), maxHeight)
            if abs(next - contentHeight) > 0.5 { contentHeight = next }
        }
    }
}
