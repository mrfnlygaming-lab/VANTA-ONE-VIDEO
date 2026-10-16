import SwiftUI

@main
struct VantaOneApp: App {
    @StateObject private var workspace = WorkspaceStore()

    var body: some Scene {
        WindowGroup {
            MainTabView()
                .environmentObject(workspace)
                .preferredColorScheme(.dark)
        }
    }
}

// VANTA ONE intentionally has no server, analytics, API keys, purchases or accounts.
enum Theme {
    static let cyan = Color(red: 0.24, green: 0.84, blue: 1.0)
    static let ink = Color(red: 0.035, green: 0.055, blue: 0.095)
    static let panel = Color(red: 0.075, green: 0.105, blue: 0.165)
    static let secondary = Color(red: 0.12, green: 0.16, blue: 0.22)
    static let muted = Color(red: 0.59, green: 0.66, blue: 0.74)
    static let gradient = LinearGradient(
        colors: [Color(red: 0.035, green: 0.075, blue: 0.13), ink],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )
}
