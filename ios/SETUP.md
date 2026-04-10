# iOS Project Setup

## Prerequisites
- Xcode 15.0+ (for iOS 17 / WidgetKit interactive buttons)
- macOS 14+ (Sonoma)
- Apple Developer account (for provisioning profiles)

## Creating the Xcode Project

Since Xcode project files (.xcodeproj) are binary/XML and must be created via Xcode,
follow these steps to assemble the project:

### 1. Create the main app

1. Open Xcode → File → New → Project
2. Choose **App** (iOS) template
3. Product Name: **HighlighterTTS**
4. Team: Your team
5. Organization Identifier: `com.highlightertts`
6. Interface: **SwiftUI**
7. Language: **Swift**
8. Save in the `ios/` directory

### 2. Add the HighlighterKit package

1. File → Add Package Dependencies
2. Click "Add Local..." and select `ios/HighlighterKit/`
3. Add **HighlighterKit** library to the main app target

### 3. Add the Widget extension

1. File → New → Target
2. Choose **Widget Extension**
3. Product Name: **HighlighterWidget**
4. Uncheck "Include Configuration App Intent" (we define our own)
5. Replace generated files with `ios/HighlighterWidget/` contents
6. Add HighlighterKit dependency to this target

### 4. Add the Share extension

1. File → New → Target
2. Choose **Share Extension**
3. Product Name: **HighlighterShareExtension**
4. Replace generated files with `ios/HighlighterShareExtension/` contents
5. Add HighlighterKit dependency to this target

### 5. Add the Safari Web Extension

1. File → New → Target
2. Choose **Safari Web Extension**
3. Product Name: **HighlighterSafariExtension**
4. Replace the generated `SafariWebExtensionHandler.swift`
5. Copy Chrome extension files into `Resources/`:
   - `background.js`
   - `content/content.js`, `content/content.css`
   - `popup/popup.html`, `popup.js`
   - `icons/`
   - `manifest.json` (use the Safari-adapted version)
6. Add HighlighterKit dependency to this target

### 6. Configure App Group

All targets must share an App Group for data exchange:

1. Select the main app target → Signing & Capabilities → + Capability → App Groups
2. Add: `group.com.highlightertts.shared`
3. Repeat for Widget, Share Extension, and Safari Extension targets

### 7. Configure URL Scheme

1. Select the main app target → Info → URL Types
2. Add URL scheme: `highlightertts`

### 8. Configure Background Audio

1. Select the main app target → Signing & Capabilities → + Capability → Background Modes
2. Enable: **Audio, AirPlay, and Picture in Picture**

### 9. Safari Extension: Adapt Chrome JS for Safari

The Chrome extension JS mostly works as-is in Safari. Minor changes needed:

- Safari supports both `chrome.*` and `browser.*` namespaces
- `contextMenus` permission is not supported in iOS Safari extensions (removed from manifest)
- Keyboard shortcuts work differently in Safari (handled by toolbar button instead)
- The content script, stroke detection, sentence parsing, and floating player all work unchanged

## Running

1. Select the HighlighterTTS scheme
2. Choose a simulator or connected device (iOS 17+)
3. Build and Run (⌘R)
4. For the widget: long-press home screen → add "Highlighter TTS" widget
5. For Safari extension: Settings → Safari → Extensions → enable Highlighter TTS

## Testing

```bash
# Run Swift package tests
cd ios/HighlighterKit
swift test
```
