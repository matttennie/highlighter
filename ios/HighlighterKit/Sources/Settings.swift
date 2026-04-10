import Foundation

/// Centralized settings backed by App Group UserDefaults.
/// Port of chrome.storage.local usage across the Chrome extension.
public final class Settings: ObservableObject {

    public static let shared = Settings()

    private let defaults: UserDefaults

    private init() {
        self.defaults = UserDefaults(suiteName: Constants.appGroupId) ?? .standard
    }

    // MARK: - API Key (stored in Keychain, not UserDefaults)

    public var apiKey: String {
        get { KeychainHelper.load() ?? "" }
        set {
            if newValue.isEmpty {
                KeychainHelper.delete()
            } else {
                KeychainHelper.save(apiKey: newValue)
            }
            objectWillChange.send()
        }
    }

    // MARK: - Voice

    @Published public var voiceId: String {
        didSet { defaults.set(voiceId, forKey: "voiceId") }
    }

    // MARK: - Speed

    @Published public var speed: Double {
        didSet { defaults.set(speed, forKey: "speed") }
    }

    // MARK: - Model

    @Published public var modelId: String {
        didSet { defaults.set(modelId, forKey: "modelId") }
    }

    // MARK: - Article Mode

    @Published public var articleMode: Bool {
        didSet { defaults.set(articleMode, forKey: "articleMode") }
    }

    // MARK: - Shared Text (widget/share extension -> app)

    /// Text queued by the widget or share extension for the app to read.
    public var pendingText: String? {
        get { defaults.string(forKey: "pendingText") }
        set { defaults.set(newValue, forKey: "pendingText") }
    }

    // MARK: - Init from stored values

    private convenience init(placeholder: Bool = false) {
        self.init()
    }

    // Load stored values
    func loadFromDefaults() {
        voiceId = defaults.string(forKey: "voiceId") ?? Constants.defaultVoiceId
        speed = defaults.double(forKey: "speed").nonZero ?? 1.0
        modelId = defaults.string(forKey: "modelId") ?? Constants.defaultModelId
        articleMode = defaults.object(forKey: "articleMode") as? Bool ?? true
    }
}

private extension Double {
    /// Returns self if non-zero, nil otherwise (for optional chaining with defaults).
    var nonZero: Double? { self == 0 ? nil : self }
}
