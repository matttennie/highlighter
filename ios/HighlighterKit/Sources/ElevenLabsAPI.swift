import Foundation

/// Client for the ElevenLabs TTS API.
/// Port of `background.js` handleTtsRequest/handleVoicesRequest/requestElevenLabsTts.
public final class ElevenLabsAPI {

    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    // MARK: - Text-to-Speech

    /// Synthesize speech from text, returning raw MP3 audio data.
    public func synthesize(
        text: String,
        voiceId: String?,
        speed: Double?,
        modelId: String?,
        apiKey: String
    ) async throws -> Data {
        // Validate API key
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw TTSError.noToken }
        guard key.hasPrefix("sk_") else {
            throw TTSError.unsupportedProvider("Use an ElevenLabs API key that starts with sk_.")
        }

        // Validate text
        let normalizedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedText.isEmpty else { throw TTSError.emptyText }
        guard normalizedText.count <= Constants.maxTextLength else {
            throw TTSError.textTooLong(normalizedText.count, Constants.maxTextLength)
        }

        // Validate voice
        let voice = (voiceId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedVoice = voice.isEmpty ? Constants.defaultVoiceId : voice

        // Validate model
        let model = Constants.supportedModelIds.contains(modelId ?? "")
            ? modelId! : Constants.defaultModelId

        let normalizedSpeed = Self.normalizeSpeed(speed)

        let url = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(resolvedVoice)")!

        var request = URLRequest(url: url, timeoutInterval: Constants.fetchTimeoutSeconds)
        request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "xi-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")

        let body: [String: Any] = [
            "text": normalizedText,
            "model_id": model,
            "voice_settings": ["speed": normalizedSpeed],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw TTSError.apiError(0, "Invalid response")
        }

        try Self.checkHTTPStatus(httpResponse, data: data)
        return data
    }

    // MARK: - Voice Listing

    /// Fetch available voices, filtered to premade + user-owned.
    public func fetchVoices(apiKey: String) async throws -> [Voice] {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw TTSError.noToken }
        guard key.hasPrefix("sk_") else {
            throw TTSError.unsupportedProvider("Use an ElevenLabs API key that starts with sk_.")
        }

        let url = URL(string: "https://api.elevenlabs.io/v1/voices")!
        var request = URLRequest(url: url, timeoutInterval: Constants.fetchTimeoutSeconds)
        request.httpMethod = "GET"
        request.setValue(key, forHTTPHeaderField: "xi-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw TTSError.apiError(0, "Invalid response")
        }

        try Self.checkHTTPStatus(httpResponse, data: data)

        let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let voiceArray = payload?["voices"] as? [[String: Any]] else {
            return []
        }

        return voiceArray.compactMap { v -> Voice? in
            guard Self.isSelectableVoice(v) else { return nil }
            let voiceId = v["voice_id"] as? String ?? ""
            let name = v["name"] as? String ?? voiceId
            let category = v["category"] as? String ?? "Other"
            return Voice(voiceId: voiceId, name: name, category: category)
        }
    }

    // MARK: - Helpers

    /// Normalize speed to ElevenLabs-supported [0.7, 1.2] range.
    /// Port of `normalizeSpeed` from background.js.
    public static func normalizeSpeed(_ speed: Double?) -> Double {
        guard let speed, speed.isFinite else { return 1.0 }
        return max(0.7, min(1.2, speed))
    }

    /// Port of `isSelectableVoice` from background.js.
    private static func isSelectableVoice(_ voice: [String: Any]) -> Bool {
        if voice["category"] as? String == "premade" { return true }
        if voice["is_owner"] as? Bool == true { return true }
        return false
    }

    /// Map HTTP error status codes to TTSError.
    private static func checkHTTPStatus(_ response: HTTPURLResponse, data: Data) throws {
        guard !response.isSuccess else { return }

        let detail = parseErrorDetail(data: data, statusText: response.statusText)

        switch response.statusCode {
        case 401: throw TTSError.authFailed(detail)
        case 402: throw TTSError.billingRequired(detail)
        case 429: throw TTSError.rateLimited(detail)
        default: throw TTSError.apiError(response.statusCode, detail)
        }
    }

    /// Port of `parseErrorDetail` from background.js.
    private static func parseErrorDetail(data: Data, statusText: String) -> String {
        if let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let detail = body["detail"] as? [String: Any] {
                return detail["message"] as? String
                    ?? detail["status"] as? String
                    ?? statusText
            }
            if let message = body["message"] as? String { return message }
        }
        if let text = String(data: data, encoding: .utf8), !text.isEmpty { return text }
        return statusText
    }
}

// MARK: - HTTPURLResponse helpers

private extension HTTPURLResponse {
    var isSuccess: Bool { (200..<300).contains(statusCode) }
    var statusText: String { HTTPURLResponse.localizedString(forStatusCode: statusCode) }
}
