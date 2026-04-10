import Foundation

// MARK: - Sentence

public struct Sentence: Identifiable, Equatable {
    public let id = UUID()
    public let text: String
    /// Character range within the source string
    public let range: Range<String.Index>

    public init(text: String, range: Range<String.Index>) {
        self.text = text
        self.range = range
    }

    public static func == (lhs: Sentence, rhs: Sentence) -> Bool {
        lhs.text == rhs.text && lhs.range == rhs.range
    }
}

// MARK: - Voice

public struct Voice: Identifiable, Codable, Equatable {
    public let voiceId: String
    public let name: String
    public let category: String

    public var id: String { voiceId }

    public init(voiceId: String, name: String, category: String) {
        self.voiceId = voiceId
        self.name = name
        self.category = category
    }
}

// MARK: - Playback State

public enum PlaybackState: String {
    case idle
    case loading
    case playing
    case paused
    case error
}

// MARK: - TTS Error

public enum TTSError: LocalizedError {
    case noToken
    case unsupportedProvider(String)
    case emptyText
    case textTooLong(Int, Int)
    case invalidVoice
    case authFailed(String)
    case billingRequired(String)
    case rateLimited(String)
    case timeout
    case apiError(Int, String)

    public var errorDescription: String? {
        switch self {
        case .noToken:
            return "No API key configured. Add your ElevenLabs API key in Settings."
        case .unsupportedProvider(let detail):
            return detail
        case .emptyText:
            return "No text to read."
        case .textTooLong(let length, let max):
            return "Text is \(length) characters; maximum is \(max)."
        case .invalidVoice:
            return "Voice ID is empty."
        case .authFailed(let detail):
            return "Authentication failed: \(detail)"
        case .billingRequired(let detail):
            return "Billing required: \(detail)"
        case .rateLimited(let detail):
            return "Rate limited: \(detail)"
        case .timeout:
            return "Request timed out."
        case .apiError(let status, let detail):
            return "API error (\(status)): \(detail)"
        }
    }
}

// MARK: - Constants

public enum Constants {
    public static let defaultVoiceId = "JBFqnCBsd6RMkjVDRZzb"
    public static let defaultModelId = "eleven_flash_v2_5"
    public static let maxTextLength = 5000
    public static let fetchTimeoutSeconds: TimeInterval = 30
    public static let speeds: [Double] = [0.7, 0.75, 0.9, 1.0, 1.1, 1.2]
    public static let supportedModelIds: Set<String> = [
        "eleven_flash_v2_5",
        "eleven_turbo_v2_5",
        "eleven_multilingual_v2",
    ]
    public static let appGroupId = "group.com.highlightertts.shared"
    public static let urlScheme = "highlightertts"
}
