import SafariServices
import os.log
import HighlighterKit

/// Native message handler bridging the Safari Web Extension JS code to the iOS app.
///
/// The existing Chrome extension JS files (background.js, content/content.js, etc.)
/// are placed in the Resources/ directory and run as a Safari Web Extension.
/// This handler bridges settings between the extension's browser.storage and the
/// App Group UserDefaults used by the iOS app + widget.
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private let logger = Logger(subsystem: "com.highlightertts.safari", category: "extension")

    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let userInfo = item.userInfo as? [String: Any],
              let message = userInfo[SFExtensionMessageKey] as? [String: Any] else {
            context.completeRequest(returningItems: nil)
            return
        }

        let action = message["action"] as? String ?? ""
        logger.info("Received message: \(action)")

        let response: [String: Any]

        switch action {
        case "getSettings":
            // Provide App Group settings to the extension JS
            let settings = Settings.shared
            response = [
                "apiKey": settings.apiKey,
                "voiceId": settings.voiceId,
                "speed": settings.speed,
                "modelId": settings.modelId,
                "articleMode": settings.articleMode,
            ]

        case "saveSettings":
            // Sync settings from extension JS to App Group
            let settings = Settings.shared
            if let apiKey = message["apiKey"] as? String { settings.apiKey = apiKey }
            if let voiceId = message["voiceId"] as? String { settings.voiceId = voiceId }
            if let speed = message["speed"] as? Double { settings.speed = speed }
            if let modelId = message["modelId"] as? String { settings.modelId = modelId }
            if let articleMode = message["articleMode"] as? Bool { settings.articleMode = articleMode }
            response = ["ok": true]

        default:
            response = ["error": "Unknown action: \(action)"]
        }

        let responseItem = NSExtensionItem()
        responseItem.userInfo = [SFExtensionMessageKey: response]
        context.completeRequest(returningItems: [responseItem])
    }
}
