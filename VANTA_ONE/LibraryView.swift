import SwiftUI
import UIKit

struct LibraryView: View {
    @EnvironmentObject private var store: WorkspaceStore
    @State private var selectedImage: SavedImage?

    private let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                SectionHeading(icon: "square.stack.3d.up.fill", headline: "Your library.",
                               subline: "Images and conversations stay in this app's local storage.")
                HStack {
                    libraryStat("\(store.threads.count)", "CONVERSATIONS")
                    libraryStat("\(store.gallery.count)", "IMAGES")
                }
                Text("GENERATED IMAGES")
                    .font(.caption.weight(.heavy)).tracking(1.4).foregroundStyle(Theme.cyan)
                if store.gallery.isEmpty {
                    ContentUnavailableView("No images yet", systemImage: "photo.stack",
                                           description: Text("Make your first image in Create."))
                        .frame(maxWidth: .infinity)
                        .padding(.top, 24)
                } else {
                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(store.gallery) { item in
                            Button { selectedImage = item } label: {
                                VStack(alignment: .leading, spacing: 8) {
                                    if let image = UIImage(contentsOfFile: store.imageURL(for: item).path) {
                                        Image(uiImage: image).resizable().scaledToFill()
                                            .frame(maxWidth: .infinity)
                                            .frame(height: 155).clipped()
                                            .clipShape(RoundedRectangle(cornerRadius: 13))
                                    }
                                    Text(item.prompt).font(.caption).lineLimit(2)
                                        .foregroundStyle(.white)
                                }
                                .padding(8)
                                .background(Theme.panel, in: RoundedRectangle(cornerRadius: 17))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(18)
        }
        .background(Theme.gradient.ignoresSafeArea())
        .navigationTitle("Library")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $selectedImage) { item in
            NavigationStack {
                VStack(spacing: 20) {
                    if let image = UIImage(contentsOfFile: store.imageURL(for: item).path) {
                        Image(uiImage: image).resizable().scaledToFit()
                            .frame(maxHeight: 490)
                            .clipShape(RoundedRectangle(cornerRadius: 20))
                    }
                    Text(item.prompt).font(.subheadline).foregroundStyle(Theme.muted)
                    HStack {
                        ShareLink(item: store.imageURL(for: item)) {
                            Label("Share or save", systemImage: "square.and.arrow.up")
                        }
                        Spacer()
                        Button("Delete", role: .destructive) {
                            store.deleteImage(item)
                            selectedImage = nil
                        }
                    }
                    .padding()
                    Spacer()
                }
                .padding()
                .background(Theme.ink.ignoresSafeArea())
                .navigationTitle("Image")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { selectedImage = nil } } }
            }
        }
    }

    private func libraryStat(_ number: String, _ description: String) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(number).font(.system(size: 32, weight: .heavy, design: .rounded)).foregroundStyle(Theme.cyan)
            Text(description).font(.system(size: 10, weight: .bold)).tracking(0.6).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 17))
    }
}
