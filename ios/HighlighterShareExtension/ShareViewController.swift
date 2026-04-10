import UIKit
import UniformTypeIdentifiers
import HighlighterKit

/// Share Extension that receives text from any app and hands it off to the main app for TTS.
class ShareViewController: UIViewController {

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        handleSharedContent()
    }

    private func handleSharedContent() {
        guard let extensionItems = extensionContext?.inputItems as? [NSExtensionItem] else {
            complete()
            return
        }

        for item in extensionItems {
            guard let attachments = item.attachments else { continue }
            for provider in attachments {
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { [weak self] data, _ in
                        if let text = data as? String, !text.isEmpty {
                            self?.sendToApp(text: text)
                        } else {
                            self?.complete()
                        }
                    }
                    return
                }

                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] data, _ in
                        if let url = data as? URL {
                            // For URLs, pass the URL string — the app could fetch the page content
                            self?.sendToApp(text: url.absoluteString)
                        } else {
                            self?.complete()
                        }
                    }
                    return
                }
            }
        }

        complete()
    }

    private func sendToApp(text: String) {
        // Store text in App Group for the main app to read
        let defaults = UserDefaults(suiteName: Constants.appGroupId)
        defaults?.set(text, forKey: "pendingText")

        // Open the main app via URL scheme
        let url = URL(string: "\(Constants.urlScheme)://read")!
        var responder: UIResponder? = self
        while let next = responder?.next {
            if let application = next as? UIApplication {
                application.open(url)
                break
            }
            responder = next
        }

        complete()
    }

    private func complete() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
