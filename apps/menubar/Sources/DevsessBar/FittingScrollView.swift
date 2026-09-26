import SwiftUI

private struct ContentHeightKey: PreferenceKey {
    static var defaultValue: CGFloat { 0 }

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

struct FittingScrollView<Content: View>: View {
    let maxHeight: CGFloat
    let initialHeight: CGFloat
    @ViewBuilder let content: () -> Content
    @LegacyState private var contentHeight: CGFloat

    init(maxHeight: CGFloat, initialHeight: CGFloat, @ViewBuilder content: @escaping () -> Content) {
        self.maxHeight = maxHeight
        self.initialHeight = initialHeight
        self.content = content
        _contentHeight = LegacyState(initialValue: min(initialHeight, maxHeight))
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
        .clipped()
        .onChange(of: initialHeight) { _, height in
            contentHeight = min(height, maxHeight)
        }
        .onPreferenceChange(ContentHeightKey.self) { height in
            // MenuBarExtra can report zero during its first layout; keep the model-derived viewport.
            guard height > 0 else { return }
            let next = min(height.rounded(.up), maxHeight)
            if abs(next - contentHeight) > 0.5 { contentHeight = next }
        }
    }
}
