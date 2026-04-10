import SwiftUI
import HighlighterKit

struct ContentView: View {
    var body: some View {
        TabView {
            ReaderView()
                .tabItem {
                    Label("Reader", systemImage: "text.bubble")
                }

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
    }
}
