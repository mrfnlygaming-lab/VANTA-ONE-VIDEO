import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import UIKit

struct ChatView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @StateObject private var ai = OfflineAI()
    @StateObject private var voiceIn = VoiceInput()
    @StateObject private var voiceOut = VoiceOutput()

    @State private var composer = ""
    @State private var mode: AIMode = .general
    @State private var busy = false
    @State private var task: Task<Void, Never>?
    @State private var showHistory = false
    @State private var pickedPhoto: PhotosPickerItem?
    @State private var showFiles = false
    @State private var attachmentName: String?
    @State private var attachmentText: String?
    @State private var alertText: String?
    @State private var exportURL: URL?
    @State private var showShare = false
    @FocusState private var composerFocus: Bool

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Divider().overlay(Theme.secondary)
            messages
            composerPanel
        }
        .background(Theme.gradient.ignoresSafeArea())
        .navigationBarHidden(true)
        .sheet(isPresented: $showHistory) { historySheet }
        .sheet(isPresented: $showShare) {
            if let exportURL { ShareSheet(items: [exportURL]) }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.pdf, .plainText, .utf8PlainText]) { result in
            switch result {
            case .success(let url):
                do {
                    let text = try LocalReader.textFromDocument(url: url)
                    attachmentText = String(text.prefix(17000))
                    attachmentName = url.lastPathComponent
                } catch { alertText = error.localizedDescription }
            case .failure(let error): alertText = error.localizedDescription
            }
        }
        .alert("VANTA ONE", isPresented: Binding(get: { alertText != nil },
                                                set: { if !$0 { alertText = nil } })) {
            Button("OK") { alertText = nil }
        } message: { Text(alertText ?? "") }
        .onChange(of: pickedPhoto) { _, selection in
            guard let selection else { return }
            Task {
                do {
                    guard let data = try await selection.loadTransferable(type: Data.self) else { return }
                    let text = try LocalReader.textFromPhoto(data: data)
                    attachmentText = String(text.prefix(17000))
                    attachmentName = "Photo text"
                } catch { alertText = "Could not scan the photo: \(error.localizedDescription)" }
                pickedPhoto = nil
            }
        }
        .onChange(of: voiceIn.transcript) { _, value in
            if !value.isEmpty { composer = value }
        }
        .onChange(of: voiceIn.message) { _, value in
            if let value { alertText = value; voiceIn.message = nil }
        }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            VantaMark(size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text("VANTA ONE")
                    .font(.system(size: 18, weight: .heavy, design: .rounded))
                    .tracking(0.5)
                Text(store.currentThread?.title ?? "New conversation")
                    .font(.caption).foregroundStyle(Theme.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            StatusPill(ready: ai.ready)
            Menu {
                Button("New conversation", systemImage: "plus.bubble") { store.newThread() }
                Button("Conversation history", systemImage: "clock.arrow.circlepath") { showHistory = true }
                Button("Share conversation", systemImage: "square.and.arrow.up") {
                    exportURL = store.exportConversation()
                    showShare = exportURL != nil
                }
            } label: {
                Image(systemName: "ellipsis.circle.fill")
                    .font(.title2).foregroundStyle(.white)
            }
            .accessibilityLabel("Conversation options")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
    }

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    if store.currentEntries.isEmpty { emptyState }
                    ForEach(store.currentEntries) { entry in
                        messageView(entry)
                            .id(entry.id)
                    }
                    if busy {
                        HStack(spacing: 10) {
                            VantaMark(size: 26)
                            ProgressView().tint(Theme.cyan)
                            Text("Thinking on your iPhone…")
                                .foregroundStyle(Theme.muted).font(.footnote)
                        }
                        .id("loading")
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: store.currentEntries.count) { _, _ in
                if let last = store.currentEntries.last?.id {
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
            .onChange(of: busy) { _, value in
                if value { withAnimation { proxy.scrollTo("loading", anchor: .bottom) } }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 24) {
            Spacer(minLength: 18)
            VantaMark(size: 68)
                .shadow(color: Theme.cyan.opacity(0.25), radius: 24)
            VStack(alignment: .leading, spacing: 8) {
                Text("Your mind.\nNo limits on ideas.")
                    .font(.system(size: 36, weight: .bold, design: .rounded))
                    .tracking(-1.5)
                    .foregroundStyle(.white)
                Text("Chat, create, write, study and brainstorm privately. No API key or credits.")
                    .font(.subheadline).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !ai.ready {
                Text(ai.status)
                    .font(.subheadline)
                    .foregroundStyle(.orange)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.panel, in: RoundedRectangle(cornerRadius: 14))
            }
            VStack(spacing: 10) {
                suggestion("Create a viral stream idea with a real plot", icon: "video")
                suggestion("Help me write a powerful song", icon: "music.mic")
                suggestion("Explain something I don't understand", icon: "lightbulb")
                suggestion("/calc (144 * 7) / 12", icon: "plus.forwardslash.minus")
            }
            Spacer(minLength: 12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func suggestion(_ text: String, icon: String) -> some View {
        Button {
            composer = text
            composerFocus = true
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon).foregroundStyle(Theme.cyan).frame(width: 20)
                Text(text).font(.subheadline).foregroundStyle(.white)
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.left").font(.caption).foregroundStyle(Theme.muted)
            }
            .padding(15)
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: 15))
        }
        .buttonStyle(.plain)
    }

    private func messageView(_ entry: ChatEntry) -> some View {
        HStack(alignment: .top, spacing: 10) {
            if entry.role == .assistant { VantaMark(size: 29) }
            VStack(alignment: .leading, spacing: 9) {
                Text(entry.role == .user ? "YOU" : "VANTA")
                    .font(.system(size: 10, weight: .black, design: .monospaced))
                    .tracking(1.1)
                    .foregroundStyle(entry.role == .user ? Theme.muted : Theme.cyan)
                Text(entry.text)
                    .font(.system(size: 15.5))
                    .textSelection(.enabled)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let attachment = entry.attachmentName {
                    Label(attachment, systemImage: "paperclip")
                        .font(.caption).foregroundStyle(Theme.cyan)
                        .lineLimit(1)
                }
                HStack(spacing: 18) {
                    Button { UIPasteboard.general.string = entry.text } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                    if entry.role == .assistant {
                        Button { voiceOut.speak(entry.text) } label: {
                            Label("Listen", systemImage: "speaker.wave.2")
                        }
                    }
                }
                .font(.caption)
                .foregroundStyle(Theme.muted)
                .buttonStyle(.plain)
            }
            .padding(14)
            .background(entry.role == .user ? Theme.secondary : Theme.panel,
                        in: RoundedRectangle(cornerRadius: 18))
            if entry.role == .user { Spacer(minLength: 24) }
        }
    }

    private var composerPanel: some View {
        VStack(spacing: 11) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(AIMode.allCases) { candidate in
                        Button { mode = candidate } label: {
                            Label(candidate.rawValue, systemImage: candidate.icon)
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 11).padding(.vertical, 8)
                                .background(mode == candidate ? Theme.cyan.opacity(0.17) : Theme.secondary,
                                            in: Capsule())
                                .foregroundStyle(mode == candidate ? Theme.cyan : Theme.muted)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            if let attachmentName {
                HStack {
                    Label(attachmentName, systemImage: "paperclip")
                        .font(.caption).foregroundStyle(Theme.cyan).lineLimit(1)
                    Spacer()
                    Button { self.attachmentName = nil; self.attachmentText = nil } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted)
                    }
                }
                .padding(.horizontal, 12)
            }
            HStack(alignment: .bottom, spacing: 10) {
                PhotosPicker(selection: $pickedPhoto, matching: .images) {
                    Image(systemName: "photo.badge.plus")
                        .font(.system(size: 21)).foregroundStyle(Theme.cyan)
                        .frame(width: 29, height: 38)
                }
                .accessibilityLabel("Read a photo")
                Button { showFiles = true } label: {
                    Image(systemName: "doc.badge.plus")
                        .font(.system(size: 21)).foregroundStyle(Theme.cyan)
                        .frame(width: 26, height: 38)
                }
                .accessibilityLabel("Open a PDF or text document")
                TextField("Message VANTA…", text: $composer, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...5)
                    .focused($composerFocus)
                    .tint(Theme.cyan)
                    .padding(.vertical, 8)
                Button {
                    voiceIn.toggle()
                } label: {
                    Image(systemName: voiceIn.isListening ? "waveform.circle.fill" : "mic.fill")
                        .font(.system(size: 21))
                        .foregroundStyle(voiceIn.isListening ? .red : Theme.muted)
                        .frame(width: 30, height: 38)
                }
                .accessibilityLabel(voiceIn.isListening ? "Stop dictation" : "Dictate on device")
                Button {
                    if busy { task?.cancel(); busy = false }
                    else { send() }
                } label: {
                    Image(systemName: busy ? "stop.fill" : "arrow.up")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(Theme.ink)
                        .frame(width: 38, height: 38)
                        .background(Theme.cyan, in: RoundedRectangle(cornerRadius: 12))
                }
                .disabled(!busy && composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachmentText == nil)
                .opacity((busy || !composer.isEmpty || attachmentText != nil) ? 1 : 0.4)
                .accessibilityLabel(busy ? "Stop response" : "Send")
            }
            .padding(9)
            .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 20))
            Text("PRIVATE ON-DEVICE AI · NO CREDITS · NO SUBSCRIPTION")
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .tracking(0.6)
                .foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, 15)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .background(Theme.ink)
    }

    private func send() {
        let text = composer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || attachmentText != nil, !busy else { return }
        voiceIn.stop()
        voiceOut.stop()
        let name = attachmentName
        let extract = attachmentText
        let prompt = text.isEmpty ? "Read and explain the attached material." : text
        let prior = store.currentEntries
        store.add(role: .user, text: prompt, attachmentName: name, attachedExtract: extract)
        composer = ""
        attachmentText = nil
        attachmentName = nil
        composerFocus = false
        busy = true
        let selected = mode
        let threadID = store.activeThreadID
        let fullPrompt = extract.map { "\(prompt)\n\nAttached text from \(name ?? "document"):\n\(String($0.prefix(6500)))" } ?? prompt
        task = Task {
            do {
                let response = try await ai.answer(fullPrompt, history: prior, mode: selected)
                if !Task.isCancelled && threadID == store.activeThreadID {
                    store.add(role: .assistant, text: response.isEmpty ? "I couldn't produce a response. Please try rephrasing." : response)
                }
            } catch {
                if !Task.isCancelled && threadID == store.activeThreadID {
                    store.add(role: .assistant, text: "I couldn't complete that locally. \(error.localizedDescription)")
                }
            }
            busy = false
            task = nil
        }
    }

    private var historySheet: some View {
        NavigationStack {
            List {
                ForEach(store.threads) { thread in
                    Button {
                        task?.cancel()
                        busy = false
                        store.selectThread(thread.id)
                        showHistory = false
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "bubble.left.fill")
                                .foregroundStyle(Theme.cyan)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(thread.title).foregroundStyle(.white).lineLimit(1)
                                Text("\(thread.entries.count) messages")
                                    .font(.caption).foregroundStyle(Theme.muted)
                            }
                            Spacer()
                            if thread.id == store.activeThreadID {
                                Image(systemName: "checkmark").foregroundStyle(Theme.cyan)
                            }
                        }
                    }
                    .listRowBackground(Theme.panel)
                    .swipeActions {
                        Button("Delete", role: .destructive) { store.deleteThread(thread.id) }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.ink)
            .navigationTitle("Conversations")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { showHistory = false }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New", systemImage: "plus") {
                        store.newThread()
                        showHistory = false
                    }
                }
            }
        }
        .presentationDragIndicator(.visible)
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
