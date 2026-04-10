import SwiftUI
import HighlighterKit

/// App settings screen — port of popup/popup.html + popup.js.
struct SettingsView: View {
    @EnvironmentObject var settings: Settings
    @State private var apiKeyInput: String = ""
    @State private var voices: [Voice] = []
    @State private var saveStatus: String?

    private let api = ElevenLabsAPI()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("sk_...", text: $apiKeyInput)
                        .textContentType(.password)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .onChange(of: apiKeyInput) { _, newValue in
                            settings.apiKey = newValue
                            showSaved()
                        }
                } header: {
                    Text("ElevenLabs API Key")
                } footer: {
                    Text("Your API key is stored securely in the device Keychain.")
                }

                Section("TTS Model") {
                    Picker("Model", selection: $settings.modelId) {
                        Text("Flash v2.5 (fastest)").tag("eleven_flash_v2_5")
                        Text("Turbo v2.5").tag("eleven_turbo_v2_5")
                        Text("Multilingual v2").tag("eleven_multilingual_v2")
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }

                Section("Default Voice") {
                    if voices.isEmpty {
                        Button("Load Voices") {
                            Task { await loadVoices() }
                        }
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
                    }
                }

                Section("Default Speed") {
                    Picker("Speed", selection: $settings.speed) {
                        ForEach(Constants.speeds, id: \.self) { speed in
                            Text("\(speed, specifier: "%.2g")x").tag(speed)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Section {
                    Toggle("Article Mode", isOn: $settings.articleMode)
                } footer: {
                    Text("When enabled, the Safari extension filters out navigation, headers, footers, and sidebars.")
                }

                if let status = saveStatus {
                    Section {
                        Text(status)
                            .foregroundStyle(.secondary)
                            .font(.footnote)
                    }
                }
            }
            .navigationTitle("Settings")
            .onAppear {
                apiKeyInput = settings.apiKey
            }
        }
    }

    private var groupedVoices: [(key: String, value: [Voice])] {
        Dictionary(grouping: voices, by: \.category)
            .sorted { $0.key < $1.key }
    }

    private func loadVoices() async {
        let key = settings.apiKey
        guard !key.isEmpty else { return }
        do {
            voices = try await api.fetchVoices(apiKey: key)
        } catch {
            saveStatus = "Failed to load voices: \(error.localizedDescription)"
        }
    }

    private func showSaved() {
        saveStatus = "Saved"
        Task {
            try? await Task.sleep(for: .seconds(2))
            if saveStatus == "Saved" { saveStatus = nil }
        }
    }
}
