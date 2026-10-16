import SwiftUI

struct MainTabView: View {
    var body: some View {
        TabView {
            NavigationStack { ChatView() }
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right.fill") }
            NavigationStack { ImageStudioView() }
                .tabItem { Label("Create", systemImage: "sparkles.rectangle.stack.fill") }
            NavigationStack { LibraryView() }
                .tabItem { Label("Library", systemImage: "square.stack.3d.up.fill") }
            NavigationStack { AboutView() }
                .tabItem { Label("About", systemImage: "iphone.gen3") }
        }
        .tint(Theme.cyan)
        .background(Theme.ink)
    }
}

struct SectionHeading: View {
    let icon: String
    let headline: String
    let subline: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(headline, systemImage: icon)
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            Text(subline)
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct VantaMark: View {
    var size: CGFloat = 42
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.27)
                .fill(LinearGradient(colors: [Theme.cyan, Color(red: 0.03, green: 0.34, blue: 0.63)],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
            Image(systemName: "bolt.fill")
                .font(.system(size: size * 0.53, weight: .black))
                .foregroundStyle(Theme.ink)
        }
        .frame(width: size, height: size)
    }
}

struct StatusPill: View {
    let ready: Bool
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(ready ? .green : .orange).frame(width: 6, height: 6)
            Text(ready ? "LOCAL AI" : "SETUP NEEDED")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .tracking(1)
        }
        .foregroundStyle(ready ? Theme.cyan : Color.orange)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Theme.secondary, in: Capsule())
    }
}
