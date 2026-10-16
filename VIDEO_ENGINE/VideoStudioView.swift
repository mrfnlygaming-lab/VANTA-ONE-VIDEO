import SwiftUI
import Foundation
import AVKit

// Text-to-video uses the MOVD Core ML inference implementation.
// This is NOT a slideshow or a network API: SoraPipeline performs T5,
// STDiT denoising, and VAE decoding before Tensor2Vid writes an MP4.
struct VideoStudioView: View {
    @StateObject private var converter = Tensor2Vid()
    @State private var prompt = ""
    @State private var running = false
    @State private var errorMessage: String?
    @State private var hd = false
    @State private var lpl = true
    @State private var tokenMerge = false
    @State private var steps = 20
    @State private var seed = Int.random(in: 1...999_999)
    @State private var clips: [URL] = []
    @State private var showDetails = false
    @AppStorage("vanta.video.lastPrompt") private var lastPrompt = ""

    private var ready: Bool { VideoModelCheck.missing.isEmpty }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(spacing: 14) {
                    Image(systemName: "video.badge.waveform")
                        .font(.system(size: 30, weight: .heavy))
                        .foregroundStyle(Theme.cyan)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("VANTA VIDEO").font(.system(size: 30, weight: .heavy, design: .rounded))
                        Text("REAL ON-DEVICE TEXT-TO-VIDEO DIFFUSION")
                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                            .tracking(1).foregroundStyle(Theme.muted)
                    }
                }

                VStack(alignment: .leading, spacing: 14) {
                    Label(ready ? "MOVD ENGINE READY" : "MODEL FILES REQUIRED", systemImage: ready ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(ready ? Theme.cyan : Color.orange)
                        .font(.subheadline.weight(.bold))
                    if !ready {
                        Text("The video model packages must be added to the app when it is built. The app will not fake video generation without them.")
                            .font(.subheadline).foregroundStyle(Theme.muted)
                        Button("Show model requirements") { showDetails.toggle() }
                            .font(.subheadline.weight(.semibold))
                        if showDetails {
                            Text(VideoModelCheck.missing.prefix(12).joined(separator: "\n"))
                                .font(.system(size: 11, design: .monospaced))
                                .textSelection(.enabled)
                                .foregroundStyle(Theme.muted)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Theme.panel, in: RoundedRectangle(cornerRadius: 19))

                VStack(alignment: .leading, spacing: 14) {
                    Text("DESCRIBE THE VIDEO")
                        .font(.caption.weight(.heavy)).tracking(1.1).foregroundStyle(Theme.cyan)
                    TextField("A futuristic city with flying cars, cinematic camera movement…", text: $prompt, axis: .vertical)
                        .lineLimit(4...8)
                        .padding(14)
                        .background(Theme.secondary, in: RoundedRectangle(cornerRadius: 14))
                    HStack {
                        Text("RESOLUTION").font(.caption.weight(.heavy)).foregroundStyle(Theme.muted)
                        Spacer()
                        Picker("Resolution", selection: $hd) {
                            Text("192p").tag(false)
                            Text("256p").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .frame(maxWidth: 180)
                    }
                    Toggle("Faster step skipping (LPL)", isOn: $lpl).tint(Theme.cyan)
                    Toggle("Temporal token merging (TDTM)", isOn: $tokenMerge)
                        .tint(Theme.cyan)
                        .disabled(!VideoModelCheck.hasTDTM)
                    Stepper("Denoising steps: \(steps)", value: $steps, in: 8...50, step: 2)
                    Button(action: generate) {
                        HStack {
                            if running { ProgressView().tint(Theme.ink) }
                            Image(systemName: "sparkles.tv")
                            Text(running ? "GENERATING ON IPHONE…" : "GENERATE REAL AI VIDEO")
                                .font(.system(size: 14, weight: .heavy, design: .rounded))
                            Spacer()
                            Image(systemName: "arrow.up.right")
                        }
                        .foregroundStyle(Theme.ink)
                        .padding(17)
                        .background(Theme.cyan, in: RoundedRectangle(cornerRadius: 14))
                    }
                    .disabled(!ready || running || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .opacity(ready && !running ? 1 : 0.5)
                    Text("Videos are short (around 2–3 seconds), silent, and low-resolution. True diffusion can take many minutes or longer on a phone. No 7-second rendering promise. Image-to-video and long-form extension are not supported by this engine.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                }
                .padding(17)
                .background(Theme.panel, in: RoundedRectangle(cornerRadius: 20))

                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                        .font(.subheadline)
                        .padding(15)
                        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 15))
                }
                if let url = converter.videoURL {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("GENERATED VIDEO").font(.caption.weight(.heavy)).foregroundStyle(Theme.cyan)
                        VideoPlayer(player: AVPlayer(url: url))
                            .frame(height: 260)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                        ShareLink(item: url) {
                            Label("Save or share video", systemImage: "square.and.arrow.up")
                                .font(.subheadline.weight(.bold))
                        }
                        .foregroundStyle(Theme.cyan)
                    }
                    .padding(17)
                    .background(Theme.panel, in: RoundedRectangle(cornerRadius: 20))
                }
                if !clips.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("SAVED MP4 VIDEOS").font(.caption.weight(.heavy)).foregroundStyle(Theme.cyan)
                        ForEach(clips, id: \.self) { url in
                            HStack {
                                Image(systemName: "play.rectangle.fill").foregroundStyle(Theme.cyan)
                                Text(url.lastPathComponent).lineLimit(1).font(.footnote)
                                Spacer()
                                ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
                            }
                        }
                    }
                    .padding(17)
                    .background(Theme.panel, in: RoundedRectangle(cornerRadius: 20))
                }
            }
            .padding(18)
        }
        .background(Theme.gradient.ignoresSafeArea())
        .navigationTitle("Video studio")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if prompt.isEmpty { prompt = lastPrompt }
            refreshVideos()
        }
        .onReceive(converter.$videoURL) { url in
            guard url != nil else { return }
            running = false
            refreshVideos()
        }
        .onReceive(converter.$errorMessage) { message in
            guard let message else { return }
            errorMessage = message
            running = false
        }
    }

    private func generate() {
        guard ready, !running else { return }
        errorMessage = nil
        converter.errorMessage = nil
        converter.videoURL = nil
        lastPrompt = prompt
        running = true
        do {
            let pipeline = try SoraPipeline(resourcesAt: Bundle.main.bundleURL, videoConverter: converter)
            // Core ML inference and MP4 encoding take place on this iPhone.
            pipeline.sample(prompt: prompt + " aesthetic score: 6.5.",
                            logdir: FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0],
                            seed: seed, step: steps, mergeStep: max(1, steps / 2),
                            numLpltarget: max(3, steps / 2),
                            isBase: hd, isLPL: lpl,
                            isTDTM: tokenMerge && VideoModelCheck.hasTDTM, isCI: false, isDL: false)
            seed = Int.random(in: 1...999_999)
        } catch {
            errorMessage = error.localizedDescription
            running = false
        }
    }

    private func refreshVideos() {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("VantaVideos", isDirectory: true)
        clips = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
            .filter { $0.pathExtension.lowercased() == "mp4" }
            .sorted { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) >
                      ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
    }
}

private enum VideoModelCheck {
    static var hasTDTM: Bool {
        (0..<28).allSatisfy { FileManager.default.fileExists(atPath:
            Bundle.main.bundleURL.appendingPathComponent("stdit3_TDTM_\($0).mlmodelc").path) }
    }
    static var missing: [String] {
        let url = Bundle.main.bundleURL
        let names = ["tokenizer.json", "tokenizer_config.json", "t5embed-tokens.mlmodelc", "t5final-layer-norm.mlmodelc", "stdit3_part1.mlmodelc", "stdit3_part2.mlmodelc", "vae_temporal_part1.mlmodelc", "vae_spatial_part1.mlmodelc"]
        + (0..<24).map { "t5block-layer\($0).mlmodelc" }
        + (0..<28).map { "stdit3_ST_\($0).mlmodelc" }
        return names.filter { !FileManager.default.fileExists(atPath: url.appendingPathComponent($0).path) }
    }
}
