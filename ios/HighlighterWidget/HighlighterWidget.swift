import WidgetKit
import SwiftUI
import AppIntents

// MARK: - Timeline Provider

struct HighlighterTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> HighlighterEntry {
        HighlighterEntry(date: .now, lastText: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (HighlighterEntry) -> Void) {
        completion(HighlighterEntry(date: .now, lastText: nil))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<HighlighterEntry>) -> Void) {
        let entry = HighlighterEntry(date: .now, lastText: nil)
        // Refresh every 15 minutes (widget content is mostly static)
        let nextUpdate = Calendar.current.date(byAdding: .minute, value: 15, to: .now)!
        completion(Timeline(entries: [entry], policy: .after(nextUpdate)))
    }
}

// MARK: - Timeline Entry

struct HighlighterEntry: TimelineEntry {
    let date: Date
    let lastText: String?
}

// MARK: - Widget Views

struct HighlighterWidgetView: View {
    var entry: HighlighterEntry
    @Environment(\.widgetFamily) var family

    var body: some View {
        switch family {
        case .systemSmall:
            smallWidget
        case .systemMedium:
            mediumWidget
        default:
            smallWidget
        }
    }

    private var smallWidget: some View {
        Button(intent: ReadClipboardIntent()) {
            VStack(spacing: 8) {
                Image(systemName: "text.bubble.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(.white)
                Text("Read\nClipboard")
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .buttonStyle(.plain)
        .containerBackground(
            LinearGradient(
                colors: [.purple, .indigo],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            for: .widget
        )
    }

    private var mediumWidget: some View {
        Button(intent: ReadClipboardIntent()) {
            HStack(spacing: 16) {
                Image(systemName: "text.bubble.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(.white)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Highlighter TTS")
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text("Tap to read clipboard text aloud")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.8))
                }

                Spacer()

                Image(systemName: "play.circle.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(.white)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .buttonStyle(.plain)
        .containerBackground(
            LinearGradient(
                colors: [.purple, .indigo],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            for: .widget
        )
    }
}

// MARK: - Widget Definition

struct HighlighterWidget: Widget {
    let kind = "HighlighterWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: HighlighterTimelineProvider()) { entry in
            HighlighterWidgetView(entry: entry)
        }
        .configurationDisplayName("Highlighter TTS")
        .description("Tap to read your clipboard text aloud.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Widget Bundle (entry point)

@main
struct HighlighterWidgetBundle: WidgetBundle {
    var body: some Widget {
        HighlighterWidget()
    }
}
