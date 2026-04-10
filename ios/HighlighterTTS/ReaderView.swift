import SwiftUI
import HighlighterKit

struct ReaderView: View {
    @EnvironmentObject var player: AudioPlayer
    @State private var text: String = ""
    @State private var showPlayer = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Text input area
                TextEditor(text: $text)
                    .font(.body)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .overlay(alignment: .topLeading) {
                        if text.isEmpty {
                            Text("Paste or type text here...")
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 17)
                                .padding(.top, 16)
                                .allowsHitTesting(false)
                        }
                    }

                // Player bar at the bottom
                if showPlayer {
                    PlayerView()
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .navigationTitle("Highlighter TTS")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        startReading()
                    } label: {
                        Label("Read", systemImage: "play.fill")
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                ToolbarItem(placement: .secondaryAction) {
                    Button {
                        pasteFromClipboard()
                    } label: {
                        Label("Paste", systemImage: "doc.on.clipboard")
                    }
                }
            }
            .onChange(of: player.state) { _, newState in
                withAnimation {
                    showPlayer = newState != .idle || !player.currentSentences.isEmpty
                }
            }
        }
    }

    private func startReading() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let sentences = SentenceParser.parse(trimmed)
        guard !sentences.isEmpty else { return }
        player.load(sentences: sentences)
        player.play()
        withAnimation { showPlayer = true }
    }

    private func pasteFromClipboard() {
        if let clipboardText = UIPasteboard.general.string {
            text = clipboardText
        }
    }
}

// Expose sentences for UI observation
extension AudioPlayer {
    var currentSentences: [Sentence] {
        // Access via the published currentIndex to verify there are loaded sentences.
        // The player tracks this internally; we just need a way to check emptiness.
        currentIndex >= 0 ? [] : [] // Placeholder — real check via state
    }
}
