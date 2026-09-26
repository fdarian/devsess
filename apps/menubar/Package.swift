// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DevsessBar",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Devsess", targets: ["DevsessBar"])],
    targets: [
        .executableTarget(name: "DevsessBar"),
        .testTarget(
            name: "DevsessBarTests",
            dependencies: ["DevsessBar"],
            resources: [.copy("list-runs.json")],
            // CLT's SwiftPM does not discover TestingMacros in its nested plugin directory.
            swiftSettings: [.unsafeFlags([
                "-plugin-path", "/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing"
            ])]
        )
    ],
    swiftLanguageModes: [.v6]
)
