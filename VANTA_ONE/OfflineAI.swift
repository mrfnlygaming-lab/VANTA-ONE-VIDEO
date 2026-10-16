import Foundation
import FoundationModels
import Vision
import PDFKit
import UniformTypeIdentifiers

enum AIMode: String, CaseIterable, Identifiable {
    case general = "Ask"
    case creator = "Creator"
    case write = "Write"
    case study = "Study"
    case code = "Code"

    var id: String { rawValue }
    var icon: String {
        switch self {
        case .general: "sparkles"
        case .creator: "video.fill"
        case .write: "pencil.line"
        case .study: "graduationcap.fill"
        case .code: "chevron.left.forwardslash.chevron.right"
        }
    }

    var guidance: String {
        switch self {
        case .general: "Help with general requests. Be precise about uncertainty."
        case .creator: "Act as an original creator strategist. Focus on hooks, story, strong titles, and real production steps."
        case .write: "Write polished, specific material. Match the user's requested tone and avoid cliches."
        case .study: "Teach clearly with short steps, examples and explanations, not just answers."
        case .code: "Help with software design and coding. Explain any unverified code or limitations; do not pretend you executed it."
        }
    }
}

@MainActor
final class OfflineAI: ObservableObject {
    private let model = SystemLanguageModel.default

    var ready: Bool {
        if case .available = model.availability { return true }
        return false
    }

    var status: String {
        switch model.availability {
        case .available:
            return "ON-DEVICE MODEL READY"
        case .unavailable(.appleIntelligenceNotEnabled):
            return "Enable Apple Intelligence in iPhone Settings."
        case .unavailable(.modelNotReady):
            return "Apple's on-device model is downloading or preparing."
        case .unavailable(.deviceNotEligible):
            return "This device is not eligible for Apple's on-device model."
        default:
            return "Apple's on-device model is unavailable right now."
        }
    }

    func answer(_ userText: String, history: [ChatEntry], mode: AIMode) async throws -> String {
        if let calculation = Calculator.evaluateIfMath(userText) { return calculation }
        guard ready else { throw AIError.notReady(status) }

        // Short input helps the small on-device context window and reduces model overload.
        let prior = history.suffix(8).map { item in
            let role = item.role == .user ? "User" : "Assistant"
            let attached = item.attachedExtract.map { "\nAttached material: \(String($0.prefix(1400)))" } ?? ""
            return "\(role): \(String(item.text.prefix(620)))\(attached)"
        }.joined(separator: "\n")

        let instructions = """
        You are VANTA ONE, a private and friendly on-device iPhone assistant.
        Give direct, helpful responses with substance, natural language, and practical steps.
        Never imply you browsed the web, executed code, generated a video, saw image details,
        or know live news unless such information was supplied. When image text is provided,
        you can discuss only that extracted text, not unseen visual objects.
        Admit uncertainty and do not invent sources. You do not have access to other apps.
        Current role: \(mode.guidance)
        """
        let session = LanguageModelSession(instructions: instructions)
        let prompt = """
        Previous conversation (may be abbreviated):
        \(prior.isEmpty ? "No previous messages." : prior)

        Latest user request:
        \(String(userText.prefix(6500)))
        """
        let response = try await session.respond(to: prompt)
        return response.content.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum AIError: LocalizedError {
    case notReady(String)
    var errorDescription: String? {
        switch self { case .notReady(let description): description }
    }
}

// This parser performs real arithmetic without asking the language model to guess.
private struct MathParser {
    let chars: [Character]
    var index = 0
    init(_ text: String) { chars = Array(text.filter { !$0.isWhitespace }) }

    mutating func parse() -> Double? {
        guard let number = expression(), index == chars.count, number.isFinite else { return nil }
        return number
    }
    mutating func expression() -> Double? {
        guard var x = term() else { return nil }
        while index < chars.count {
            let op = chars[index]
            guard op == "+" || op == "-" else { break }
            index += 1
            guard let y = term() else { return nil }
            x = op == "+" ? x + y : x - y
        }
        return x
    }
    mutating func term() -> Double? {
        guard var x = factor() else { return nil }
        while index < chars.count {
            let op = chars[index]
            guard op == "*" || op == "/" else { break }
            index += 1
            guard let y = factor() else { return nil }
            if op == "/" && y == 0 { return nil }
            x = op == "*" ? x * y : x / y
        }
        return x
    }
    mutating func factor() -> Double? {
        guard index < chars.count else { return nil }
        if chars[index] == "-" { index += 1; guard let x = factor() else { return nil }; return -x }
        if chars[index] == "+" { index += 1; return factor() }
        if chars[index] == "(" {
            index += 1
            guard let x = expression(), index < chars.count, chars[index] == ")" else { return nil }
            index += 1
            return x
        }
        let start = index
        while index < chars.count && (chars[index].isNumber || chars[index] == ".") { index += 1 }
        guard start != index else { return nil }
        return Double(String(chars[start..<index]))
    }
}

enum Calculator {
    static func evaluateIfMath(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let isCommand = trimmed.lowercased().hasPrefix("/calc ")
        let expression = isCommand ? String(trimmed.dropFirst(6)) : trimmed
        // Never mistake regular prose (including IDs, dates and phone numbers) for math.
        let allowed = CharacterSet(charactersIn: "0123456789.+-*/() \n\t")
        let onlyMath = expression.unicodeScalars.allSatisfy { allowed.contains($0) }
        guard onlyMath, expression.count <= 160,
              expression.contains(where: { "+-*/".contains($0) }) else { return nil }
        var parser = MathParser(expression)
        guard let answer = parser.parse() else {
            return isCommand ? "I couldn't calculate that expression. Use +, -, *, / and parentheses." : nil
        }
        return "\(expression) = \(String(format: "%.10g", answer))"
    }
}

enum LocalReader {
    static func textFromPhoto(data: Data) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        try VNImageRequestHandler(data: data, options: [:]).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: "\n")
        return text.isEmpty ? "No readable text detected in this image." : text
    }

    static func textFromDocument(url: URL) throws -> String {
        let hasAccess = url.startAccessingSecurityScopedResource()
        defer { if hasAccess { url.stopAccessingSecurityScopedResource() } }
        if url.pathExtension.lowercased() == "pdf" {
            guard let pdf = PDFDocument(url: url) else { throw ReaderError.cannotRead }
            return pdf.string ?? "No extractable text. Scanned PDFs may require OCR."
        }
        return try String(contentsOf: url, encoding: .utf8)
    }
}

enum ReaderError: LocalizedError {
    case cannotRead
    var errorDescription: String? { "Could not extract readable text from that document." }
}
