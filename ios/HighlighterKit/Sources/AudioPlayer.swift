import AVFoundation
import Foundation

/// Manages sentence-by-sentence TTS playback with ElevenLabs audio + AVSpeechSynthesizer fallback.
/// Port of the playback state machine from content/content.js lines 699-900.
@MainActor
public final class AudioPlayer: NSObject, ObservableObject {

    // MARK: - Published State

    @Published public private(set) var state: PlaybackState = .idle
    @Published public private(set) var currentIndex: Int = 0

    // MARK: - Dependencies

    private let api: ElevenLabsAPI
    private let settings: Settings

    // MARK: - Internal State

    private var sentences: [Sentence] = []
    private var avPlayer: AVAudioPlayer?
    private var speechSynth = AVSpeechSynthesizer()
    /// Monotonic counter to discard stale responses (port of pbRequestId)
    private var requestId: Int = 0

    // MARK: - Callbacks

    /// Called when all sentences have been played.
    public var onFinished: (() -> Void)?

    // MARK: - Init

    public init(api: ElevenLabsAPI = ElevenLabsAPI(), settings: Settings = .shared) {
        self.api = api
        self.settings = settings
        super.init()
        speechSynth.delegate = self
        configureAudioSession()
    }

    // MARK: - Public API

    /// Load sentences for playback.
    public func load(sentences: [Sentence]) {
        stop()
        self.sentences = sentences
        currentIndex = 0
        state = .idle
    }

    /// Start or resume playback.
    public func play() {
        switch state {
        case .idle, .error:
            guard !sentences.isEmpty else { return }
            playSentence(at: currentIndex)
        case .paused:
            resume()
        case .loading, .playing:
            break
        }
    }

    /// Pause playback.
    public func pause() {
        if let player = avPlayer, player.isPlaying {
            player.pause()
        } else {
            speechSynth.pauseSpeaking(at: .immediate)
        }
        state = .paused
    }

    /// Stop and reset.
    public func stop() {
        let id = requestId
        requestId += 1 // invalidate any in-flight requests

        avPlayer?.stop()
        avPlayer = nil
        speechSynth.stopSpeaking(at: .immediate)
        state = .idle
        _ = id // suppress unused warning
    }

    /// Skip to the next sentence.
    public func next() {
        guard !sentences.isEmpty else { return }
        let newIndex = min(currentIndex + 1, sentences.count - 1)
        guard newIndex != currentIndex else { return }
        if state == .playing || state == .loading {
            playSentence(at: newIndex)
        } else {
            currentIndex = newIndex
        }
    }

    /// Skip to the previous sentence.
    public func previous() {
        guard !sentences.isEmpty else { return }
        let newIndex = max(currentIndex - 1, 0)
        guard newIndex != currentIndex else { return }
        if state == .playing || state == .loading {
            playSentence(at: newIndex)
        } else {
            currentIndex = newIndex
        }
    }

    /// Play/pause toggle.
    public func togglePlayPause() {
        switch state {
        case .idle, .error:
            play()
        case .loading:
            stop()
        case .playing:
            pause()
        case .paused:
            resume()
        }
    }

    // MARK: - Private: Sentence Playback

    private func playSentence(at index: Int) {
        // Cancel any active speech
        speechSynth.stopSpeaking(at: .immediate)

        // Release current audio player
        avPlayer?.stop()
        avPlayer = nil

        guard index >= 0, index < sentences.count else {
            state = .idle
            onFinished?()
            return
        }

        currentIndex = index
        state = .loading
        let capturedId = incrementRequestId()
        let text = sentences[index].text

        Task {
            do {
                let audioData = try await api.synthesize(
                    text: text,
                    voiceId: settings.voiceId,
                    speed: settings.speed,
                    modelId: settings.modelId,
                    apiKey: settings.apiKey
                )

                guard capturedId == requestId else { return } // stale

                try playAudioData(audioData, requestId: capturedId, speed: settings.speed)
            } catch {
                guard capturedId == requestId else { return } // stale
                // Fallback to AVSpeechSynthesizer (port of fallbackSpeechSynthesis)
                fallbackToSpeechSynthesis(text: text, speed: settings.speed, requestId: capturedId)
            }
        }
    }

    private func playAudioData(_ data: Data, requestId: Int, speed: Double) throws {
        let player = try AVAudioPlayer(data: data)
        player.enableRate = true
        player.rate = Float(ElevenLabsAPI.normalizeSpeed(speed))
        player.delegate = self
        self.avPlayer = player

        guard player.play() else {
            fallbackToSpeechSynthesis(
                text: sentences[currentIndex].text,
                speed: speed,
                requestId: requestId
            )
            return
        }
        state = .playing
    }

    private func fallbackToSpeechSynthesis(text: String, speed: Double, requestId: Int) {
        guard requestId == self.requestId else { return }
        speechSynth.stopSpeaking(at: .immediate)

        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = Float(speed) * AVSpeechUtteranceDefaultSpeechRate
        speechSynth.speak(utterance)
        state = .playing
    }

    private func resume() {
        if let player = avPlayer {
            player.play()
            state = .playing
        } else if speechSynth.isPaused {
            speechSynth.continueSpeaking()
            state = .playing
        } else {
            playSentence(at: currentIndex)
        }
    }

    private func onAudioEnded() {
        avPlayer = nil
        if currentIndex + 1 < sentences.count {
            playSentence(at: currentIndex + 1)
        } else {
            state = .idle
            onFinished?()
        }
    }

    private func incrementRequestId() -> Int {
        requestId += 1
        return requestId
    }

    private func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenContent)
            try session.setActive(true)
        } catch {
            // Audio session configuration is best-effort
        }
    }
}

// MARK: - AVAudioPlayerDelegate

extension AudioPlayer: AVAudioPlayerDelegate {
    public nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            onAudioEnded()
        }
    }

    public nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            // Fallback to speech synthesis on decode error
            let text = sentences[currentIndex].text
            fallbackToSpeechSynthesis(text: text, speed: settings.speed, requestId: requestId)
        }
    }
}

// MARK: - AVSpeechSynthesizerDelegate

extension AudioPlayer: AVSpeechSynthesizerDelegate {
    public nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                                              didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            onAudioEnded()
        }
    }
}
