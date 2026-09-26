import SwiftUI

// CLT's macOS 27 SDK lacks SwiftUIMacros; the public wrapper still works via an alias.
typealias LegacyState<Value> = SwiftUI.State<Value>
