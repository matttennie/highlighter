import Testing
@testable import HighlighterKit

/// Port of tests/test-sentences.js to Swift.
@Suite("SentenceParser")
struct SentenceParserTests {

    @Test("Parses simple sentences")
    func simpleText() {
        let text = "Hello world. This is a test. How are you?"
        let sentences = SentenceParser.parse(text)
        #expect(sentences.count == 3)
        #expect(sentences[0].text == "Hello world.")
        #expect(sentences[1].text == "This is a test.")
        #expect(sentences[2].text == "How are you?")
    }

    @Test("Handles exclamation marks")
    func exclamationMarks() {
        let text = "Wow! That's amazing! Really?"
        let sentences = SentenceParser.parse(text)
        #expect(sentences.count == 3)
        #expect(sentences[0].text == "Wow!")
        #expect(sentences[1].text == "That's amazing!")
        #expect(sentences[2].text == "Really?")
    }

    @Test("Handles ellipsis")
    func ellipsis() {
        let text = "Well\u{2026} I suppose so. Let me think\u{2026}"
        let sentences = SentenceParser.parse(text)
        #expect(sentences.count == 2)
        #expect(sentences[0].text.hasPrefix("Well"))
        #expect(sentences[1].text.hasPrefix("Let me think"))
    }

    @Test("Handles trailing text without terminal punctuation")
    func trailingText() {
        let text = "First sentence. Then some trailing text"
        let sentences = SentenceParser.parse(text)
        #expect(sentences.count == 2)
        #expect(sentences[0].text == "First sentence.")
        #expect(sentences[1].text == "Then some trailing text")
    }

    @Test("Returns empty for empty input")
    func emptyInput() {
        #expect(SentenceParser.parse("").isEmpty)
        #expect(SentenceParser.parse("   ").isEmpty)
    }

    @Test("Single sentence without punctuation")
    func noPunctuation() {
        let sentences = SentenceParser.parse("Just some text")
        #expect(sentences.count == 1)
        #expect(sentences[0].text == "Just some text")
    }

    @Test("Ranges point to correct positions in source string")
    func rangeAccuracy() {
        let text = "First. Second."
        let sentences = SentenceParser.parse(text)
        #expect(sentences.count == 2)
        #expect(String(text[sentences[0].range]).trimmingCharacters(in: .whitespaces).hasPrefix("First"))
        #expect(String(text[sentences[1].range]).trimmingCharacters(in: .whitespaces).hasPrefix("Second"))
    }

    @Test("Handles quotes after terminals")
    func quotesAfterTerminals() {
        let text = "She said \"hello.\" Then he left."
        let sentences = SentenceParser.parse(text)
        #expect(sentences.count == 2)
    }
}
