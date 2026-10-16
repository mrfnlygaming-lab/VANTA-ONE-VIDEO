import Foundation
import SwiftUI

enum MessageRole: String, Codable {
    case user, assistant
}

struct ChatEntry: Codable, Identifiable {
    var id = UUID()
    let role: MessageRole
    let text: String
    let date: Date
    var attachmentName: String? = nil
    // This allows follow-up questions about a file or photographed text.
    var attachedExtract: String? = nil
}

struct ChatThread: Codable, Identifiable {
    var id = UUID()
    var title: String
    var createdAt = Date()
    var entries: [ChatEntry] = []
}

struct SavedImage: Codable, Identifiable {
    var id = UUID()
    let filename: String
    let prompt: String
    let createdAt: Date
}

private struct Database: Codable {
    var threads: [ChatThread]
    var activeThreadID: UUID?
    var gallery: [SavedImage]
}

@MainActor
final class WorkspaceStore: ObservableObject {
    @Published private(set) var threads: [ChatThread] = []
    @Published private(set) var activeThreadID: UUID?
    @Published private(set) var gallery: [SavedImage] = []

    private let root: URL
    private let databaseURL: URL
    private let imagesDirectory: URL

    init() {
        root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("VantaOne", isDirectory: true)
        databaseURL = root.appendingPathComponent("workspace.json")
        imagesDirectory = root.appendingPathComponent("images", isDirectory: true)
        try? FileManager.default.createDirectory(at: imagesDirectory, withIntermediateDirectories: true)

        if let data = try? Data(contentsOf: databaseURL),
           let database = try? JSONDecoder().decode(Database.self, from: data) {
            threads = database.threads
            gallery = database.gallery
            activeThreadID = database.activeThreadID
        }
        if threads.isEmpty { newThread() }
        if !threads.contains(where: { $0.id == activeThreadID }) {
            activeThreadID = threads.first?.id
        }
    }

    var currentThread: ChatThread? { threads.first(where: { $0.id == activeThreadID }) }
    var currentEntries: [ChatEntry] { currentThread?.entries ?? [] }

    func newThread() {
        let new = ChatThread(title: "New conversation")
        threads.insert(new, at: 0)
        activeThreadID = new.id
        persist()
    }

    func selectThread(_ id: UUID) {
        guard threads.contains(where: { $0.id == id }) else { return }
        activeThreadID = id
        persist()
    }

    func deleteThread(_ id: UUID) {
        threads.removeAll(where: { $0.id == id })
        if threads.isEmpty { newThread() }
        else if activeThreadID == id { activeThreadID = threads[0].id }
        persist()
    }

    func add(role: MessageRole, text: String, attachmentName: String? = nil, attachedExtract: String? = nil) {
        guard let id = activeThreadID, let index = threads.firstIndex(where: { $0.id == id }) else { return }
        let entry = ChatEntry(role: role, text: text, date: Date(),
                              attachmentName: attachmentName, attachedExtract: attachedExtract)
        threads[index].entries.append(entry)
        if role == .user && threads[index].title == "New conversation" {
            let firstLine = text.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? "Conversation"
            threads[index].title = String(firstLine.prefix(45))
        }
        persist()
    }

    func saveImage(from source: URL, prompt: String) throws {
        let ext = source.pathExtension.isEmpty ? "png" : source.pathExtension.lowercased()
        let filename = "\(UUID().uuidString).\(ext)"
        let destination = imagesDirectory.appendingPathComponent(filename)
        try FileManager.default.copyItem(at: source, to: destination)
        gallery.insert(SavedImage(filename: filename, prompt: prompt, createdAt: Date()), at: 0)
        persist()
    }

    func imageURL(for item: SavedImage) -> URL {
        imagesDirectory.appendingPathComponent(item.filename)
    }

    func deleteImage(_ item: SavedImage) {
        try? FileManager.default.removeItem(at: imageURL(for: item))
        gallery.removeAll(where: { $0.id == item.id })
        persist()
    }

    func exportConversation() -> URL? {
        guard let thread = currentThread else { return nil }
        let content = "# \(thread.title)\n\n" + thread.entries.map { entry in
            "## \(entry.role == .user ? "You" : "VANTA")\n\n\(entry.text)\n"
        }.joined(separator: "\n")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("VANTA-Conversation.md")
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
            return url
        } catch { return nil }
    }

    private func persist() {
        let database = Database(threads: threads, activeThreadID: activeThreadID, gallery: gallery)
        guard let data = try? JSONEncoder().encode(database) else { return }
        try? data.write(to: databaseURL, options: .atomic)
    }
}
