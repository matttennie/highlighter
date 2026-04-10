import SwiftUI
import HighlighterKit

/// Floating player bar — port of the Chrome extension's floating player pill.
/// Maps to content/content.js buildPlayer() lines 427-562.
struct PlayerView: View {
    @EnvironmentObject var player: AudioPlayer
    @EnvironmentObject var settings: Settings
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 16) {
                // Previous
                Button { player.previous() } label: {
                    Image(systemName: "backward.fill")
                        .font(.title3)
                }

                // Play/Pause
                Button { player.togglePlayPause() } label: {
                    Group {
                        switch player.state {
                        case .loading:
                            ProgressView()
                                .controlSize(.regular)
                        case .playing:
                            Image(systemName: "pause.fill")
                                .font(.title2)
                        default:
                            Image(systemName: "play.fill")
                                .font(.title2)
                        }
                    }
                    .frame(width: 32, height: 32)
                }

                // Next
                Button { player.next() } label: {
                    Image(systemName: "forward.fill")
                        .font(.title3)
                }

                Spacer()

                // Speed indicator
                Menu {
                    ForEach(Constants.speeds, id: \.self) { speed in
                        Button("\(speed, specifier: "%.2g")x") {
                            settings.speed = speed
                        }
                    }
                } label: {
                    Text("\(settings.speed, specifier: "%.2g")x")
                        .font(.caption)
                        .fontWeight(.medium)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(.quaternary, in: Capsule())
                }

                // Settings
                Button {
                    showSettings.toggle()
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.title3)
                }

                // Stop
                Button {
                    player.stop()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.bar)
        }
        .sheet(isPresented: $showSettings) {
            PlayerSettingsSheet()
                .presentationDetents([.medium])
        }
    }
}

/// Inline settings sheet for voice/speed selection.
/// Port of the menu panel from content.js lines 471-506.
struct PlayerSettingsSheet: View {
    @EnvironmentObject var settings: Settings
    @State private var voices: [Voice] = []
    @State private var isLoadingVoices = false

    private let api = ElevenLabsAPI()

    var body: some View {
        NavigationStack {
            Form {
                Section("Voice") {
                    if isLoadingVoices {
                        ProgressView("Loading voices...")
                    } else if voices.isEmpty {
                        Text("No voices available")
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Voice", selection: $settings.voiceId) {
                            ForEach(groupedVoices, id: \.key) { category, voiceList in
                                Section(category) {
                                    ForEach(voiceList) { voice in
                                        Text(voice.name).tag(voice.voiceId)
                                    }
                                }
                            }
                        }
                        .pickerStyle(.menu)
                    }
                }

                Section("Speed") {
                    Picker("Speed", selection: $settings.speed) {
                        ForEach(Constants.speeds, id: \.self) { speed in
                            Text("\(speed, specifier: "%.2g")x").tag(speed)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Section("Model") {
                    Picker("Model", selection: $settings.modelId) {
                        Text("Flash v2.5").tag("eleven_flash_v2_5")
                        Text("Turbo v2.5").tag("eleven_turbo_v2_5")
                        Text("Multilingual v2").tag("eleven_multilingual_v2")
                    }
                }
            }
            .navigationTitle("Playback Settings")
            .navigationBarTitleDisplayMode(.inline)
            .task { await loadVoices() }
        }
    }

    private var groupedVoices: [(key: String, value: [Voice])] {
        Dictionary(grouping: voices, by: \.category)
            .sorted { $0.key < $1.key }
    }

    private func loadVoices() async {
        let key = settings.apiKey
        guard !key.isEmpty else { return }
        isLoadingVoices = true
        defer { isLoadingVoices = false }
        do {
            voices = try await api.fetchVoices(apiKey: key)
        } catch {
            // Silently fail — user can retry
        }
    }
}
