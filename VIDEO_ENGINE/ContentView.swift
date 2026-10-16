import SwiftUI

// This is the MOVD application's entry view, replaced by the VANTA ONE overlay.
// All inference is performed on the phone; MOVD Core ML weights must be bundled.
struct ContentView: View {
    @StateObject private var workspace = WorkspaceStore()

    var body: some View {
        MainTabView()
            .environmentObject(workspace)
            .preferredColorScheme(.dark)
    }
}
