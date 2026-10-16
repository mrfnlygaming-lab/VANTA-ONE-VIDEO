import SwiftUI

struct AboutView: View {
    @StateObject private var ai = OfflineAI()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                HStack(spacing: 16) {
                    VantaMark(size: 80)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("VANTA ONE").font(.system(size: 28, weight: .heavy, design: .rounded))
                        Text("PERSONAL AI / IPHONE EDITION")
                            .font(.system(size: 10, weight: .heavy, design: .monospaced))
                            .tracking(0.9).foregroundStyle(Theme.cyan)
                    }
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("ENGINE STATUS").font(.caption.weight(.heavy)).tracking(1).foregroundStyle(Theme.cyan)
                    StatusPill(ready: ai.ready)
                    Text(ai.status).font(.subheadline).foregroundStyle(.white)
                    if !ai.ready {
                        Text("Open Settings → Apple Intelligence & Siri. Turn on Apple Intelligence, connect to Wi-Fi if model downloads are pending, and launch this app again.")
                            .font(.subheadline).foregroundStyle(Theme.muted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
                .background(Theme.panel, in: RoundedRectangle(cornerRadius: 20))

                detail("NO SUBSCRIPTIONS", "No in-app purchases, paid credits, advertising or app-specific accounts.", "dollarsign.circle")
                detail("PRIVATE BY DESIGN", "VANTA ONE does not send prompts to an app developer server. Chats and saved creations live in app storage. Apple's system frameworks govern their own processing and privacy.", "lock.shield")
                detail("PHONE-ONLY COMPUTE", "Text generation uses Foundation Models. Image generation uses Image Playground. Text from photos uses Vision. Dictation requests on-device recognition.", "iphone.gen3")
                detail("REAL LIMITATIONS", "The model is smaller than major cloud AIs. It cannot automatically browse the live web, run external apps, create Grok-quality video, or answer every possible request. Image Playground has its own styles and restrictions.", "info.circle")
                detail("STORAGE", "App data stays in this app's local container. Export important conversations and images before deleting the app, because deletion removes its local data.", "externaldrive")
                Text("VANTA ONE • VERSION 1.0 • MADE TO BE FREE")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
            }
            .padding(18)
        }
        .background(Theme.gradient.ignoresSafeArea())
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func detail(_ title: String, _ detail: String, _ icon: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundStyle(Theme.cyan).frame(width: 22)
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.caption.weight(.heavy)).tracking(1)
                Text(detail).font(.subheadline).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(17)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 17))
    }
}
