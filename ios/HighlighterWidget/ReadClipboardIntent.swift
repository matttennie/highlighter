import AppIntents
import UIKit
import HighlighterKit

/// AppIntent triggered by the widget's "Read Clipboard" button.
/// Reads clipboard text, stores it in the shared App Group, and opens the main app.
struct ReadClipboardIntent: AppIntent {
    static var title: LocalizedStringResource = "Read Clipboard"
    static var description: IntentDescription = "Read the clipboard text aloud using Highlighter TTS"

    /// Opens the main app to play audio (widgets cannot play audio directly).
    static var openAppWhenRun: Bool = true

    func perform() async throws -> some IntentResult {
        // Read clipboard
        let text = UIPasteboard.general.string ?? ""
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .result()
        }

        // Store in App Group for the main app to pick up
        let defaults = UserDefaults(suiteName: Constants.appGroupId)
        defaults?.set(text, forKey: "pendingText")

        // The app will open (openAppWhenRun = true) and read pendingText
        return .result()
    }
}
