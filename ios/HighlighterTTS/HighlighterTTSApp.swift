import SwiftUI
import HighlighterKit

@main
struct HighlighterTTSApp: App {
    @StateObject private var settings = Settings.shared
    @StateObject private var player = AudioPlayer()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(settings)
                .environmentObject(player)
                .onOpenURL(perform: handleURL)
                .onAppear {
                    settings.loadFromDefaults()
                    checkPendingText()
                }
        }
    }

    /// Handle URL scheme: highlightertts://read
    private func handleURL(_ url: URL) {
        guard url.scheme == Constants.urlScheme else { return }

        switch url.host {
        case "read":
            // Text may come via query param or App Group pending text
            if let text = url.queryParameters["text"], !text.isEmpty {
                loadAndPlay(text)
            } else {
                checkPendingText()
            }
        default:
            break
        }
    }

    private func checkPendingText() {
        if let text = settings.pendingText, !text.isEmpty {
            settings.pendingText = nil
            loadAndPlay(text)
        }
    }

    private func loadAndPlay(_ text: String) {
        let sentences = SentenceParser.parse(text)
        guard !sentences.isEmpty else { return }
        player.load(sentences: sentences)
        player.play()
    }
}

// MARK: - URL Query Parsing

private extension URL {
    var queryParameters: [String: String] {
        guard let components = URLComponents(url: self, resolvingAgainstBaseURL: false),
              let items = components.queryItems else { return [:] }
        return Dictionary(items.compactMap { item in
            item.value.map { (item.name, $0) }
        }, uniquingKeysWith: { _, last in last })
    }
}
