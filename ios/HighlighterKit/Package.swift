// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HighlighterKit",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "HighlighterKit", targets: ["HighlighterKit"]),
    ],
    targets: [
        .target(name: "HighlighterKit", path: "Sources"),
        .testTarget(name: "HighlighterKitTests", dependencies: ["HighlighterKit"], path: "Tests"),
    ]
)
