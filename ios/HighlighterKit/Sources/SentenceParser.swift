import Foundation

/// Parses text into sentences using the same regex pattern as the Chrome extension.
/// Port of `extractSentencesFromBlock` from content/content.js lines 352-397.
public enum SentenceParser {

    // Same regex as content.js: /[^!.?…]*(?:[!.?…]+['"'"]?\s*)/g
    // Matches runs of non-terminal chars followed by one or more terminals and
    // optional closing quotes + whitespace.
    private static let sentencePattern: NSRegularExpression = {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(
            pattern: #"[^!.?\u{2026}]*(?:[!.?\u{2026}]+['"'\u{2018}\u{201C}]?\s*)"#,
            options: []
        )
    }()

    /// Parse a block of text into sentences, returning each with its text and
    /// range within the source string.
    public static func parse(_ text: String) -> [Sentence] {
        guard !text.isEmpty else { return [] }

        var results: [Sentence] = []
        let nsText = text as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)
        var consumed = 0

        let matches = sentencePattern.matches(in: text, options: [], range: fullRange)

        for match in matches {
            let nsRange = match.range
            let raw = nsText.substring(with: nsRange)
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                consumed = nsRange.location + nsRange.length
                continue
            }

            guard let swiftRange = Range(nsRange, in: text) else {
                consumed = nsRange.location + nsRange.length
                continue
            }

            results.append(Sentence(text: trimmed, range: swiftRange))
            consumed = nsRange.location + nsRange.length
        }

        // Handle trailing text that doesn't end with a sentence terminal
        if consumed < nsText.length {
            let tail = nsText.substring(from: consumed)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !tail.isEmpty {
                let startIndex = text.index(text.startIndex, offsetBy: consumed)
                results.append(Sentence(text: tail, range: startIndex..<text.endIndex))
            }
        }

        return results
    }
}
