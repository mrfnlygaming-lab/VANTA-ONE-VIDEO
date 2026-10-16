import SwiftUI
import PhotosUI
import ImagePlayground
import UIKit

struct ImageStudioView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @Environment(\.supportsImagePlayground) private var supportsImagePlayground
    @State private var prompt = ""
    @State private var showPlayground = false
    @State private var sourceItem: PhotosPickerItem?
    @State private var sourceImage: UIImage?
    @State private var errorText: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                SectionHeading(icon: "sparkles.rectangle.stack.fill",
                               headline: "Create something.",
                               subline: "Make images on your phone with Apple's built-in Image Playground. No paid image API.")
                VStack(alignment: .leading, spacing: 13) {
                    Text("YOUR IDEA").font(.caption.weight(.heavy)).tracking(1.3).foregroundStyle(Theme.cyan)
                    TextField("Describe the image you want…", text: $prompt, axis: .vertical)
                        .lineLimit(3...7)
                        .padding(15)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 16))
                    PhotosPicker(selection: $sourceItem, matching: .images) {
                        HStack {
                            Image(systemName: "photo.on.rectangle")
                            Text(sourceImage == nil ? "Use a reference photo" : "Change reference photo")
                            Spacer()
                            Image(systemName: "plus")
                        }
                        .font(.subheadline.weight(.medium))
                        .padding(15)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 15))
                        .foregroundStyle(.white)
                    }
                    if let sourceImage {
                        Image(uiImage: sourceImage)
                            .resizable().scaledToFit()
                            .frame(maxHeight: 190)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        Button("Remove reference photo", role: .destructive) { self.sourceImage = nil }
                            .font(.caption)
                    }
                    Button { showPlayground = true } label: {
                        HStack {
                            Image(systemName: "wand.and.stars")
                            Text("GENERATE IMAGE")
                            Spacer()
                            Image(systemName: "arrow.up.right")
                        }
                        .font(.system(size: 15, weight: .heavy, design: .rounded))
                        .padding(17)
                        .background(Theme.cyan, in: RoundedRectangle(cornerRadius: 15))
                        .foregroundStyle(Theme.ink)
                    }
                    .disabled(!supportsImagePlayground || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .opacity(supportsImagePlayground ? 1 : 0.45)
                    if !supportsImagePlayground {
                        Text("Image Playground is not available. Check Apple Intelligence and Image Playground in Settings.")
                            .font(.footnote).foregroundStyle(.orange)
                    }
                }
                .padding(18)
                .background(Theme.panel, in: RoundedRectangle(cornerRadius: 22))
                VStack(alignment: .leading, spacing: 8) {
                    Text("BUILT ON YOUR IPHONE")
                        .font(.caption.weight(.heavy)).tracking(1.1).foregroundStyle(Theme.cyan)
                    Text("Generated styles and editing capabilities depend on Apple's Image Playground. This is not Grok's photorealistic video engine, and video generation is not included.")
                        .font(.subheadline).foregroundStyle(Theme.muted)
                }
                .padding(17)
                .background(Theme.panel, in: RoundedRectangle(cornerRadius: 18))
                if !store.gallery.isEmpty {
                    Text("RECENT CREATIONS")
                        .font(.caption.weight(.heavy)).tracking(1.2).foregroundStyle(Theme.cyan)
                    ForEach(store.gallery.prefix(3)) { item in
                        HStack(spacing: 13) {
                            if let image = UIImage(contentsOfFile: store.imageURL(for: item).path) {
                                Image(uiImage: image).resizable().scaledToFill()
                                    .frame(width: 76, height: 76).clipped()
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                            }
                            Text(item.prompt).lineLimit(3).font(.subheadline)
                            Spacer()
                        }
                        .padding(10)
                        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 16))
                    }
                }
            }
            .padding(18)
        }
        .background(Theme.gradient.ignoresSafeArea())
        .navigationTitle("Image studio")
        .navigationBarTitleDisplayMode(.inline)
        .imagePlaygroundSheet(isPresented: $showPlayground,
                              concept: prompt,
                              sourceImage: sourceImage.map { Image(uiImage: $0) },
                              onCompletion: { url in
            do { try store.saveImage(from: url, prompt: prompt) }
            catch { errorText = "Image created but could not be saved: \(error.localizedDescription)" }
        })
        .onChange(of: sourceItem) { _, newItem in
            guard let newItem else { return }
            Task {
                if let data = try? await newItem.loadTransferable(type: Data.self) {
                    sourceImage = UIImage(data: data)
                }
                sourceItem = nil
            }
        }
        .alert("Image Studio", isPresented: Binding(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
            Button("OK") { errorText = nil }
        } message: { Text(errorText ?? "") }
    }
}
