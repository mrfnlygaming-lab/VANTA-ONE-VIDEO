import SwiftUI
import Speech
import AVFoundation

@MainActor
final class VoiceInput: NSObject, ObservableObject {
    @Published var isListening = false
    @Published var transcript = ""
    @Published var message: String? = nil

    private let engine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func toggle() {
        if isListening { stop(); return }
        SFSpeechRecognizer.requestAuthorization { speechPermission in
            AVAudioApplication.requestRecordPermission { microphonePermission in
                Task { @MainActor in
                    guard speechPermission == .authorized, microphonePermission else {
                        self.message = "Allow microphone and speech recognition in iPhone Settings."
                        return
                    }
                    self.start()
                }
            }
        }
    }

    private func start() {
        guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            message = "On-device speech recognition isn't available for this language."
            return
        }
        stop()
        transcript = ""
        let newRequest = SFSpeechAudioBufferRecognitionRequest()
        newRequest.shouldReportPartialResults = true
        newRequest.requiresOnDeviceRecognition = true
        request = newRequest

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let input = engine.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
                newRequest.append(buffer)
            }
            engine.prepare()
            try engine.start()
            isListening = true
            task = recognizer.recognitionTask(with: newRequest) { [weak self] result, error in
                Task { @MainActor in
                    guard let self else { return }
                    if let result { self.transcript = result.bestTranscription.formattedString }
                    if error != nil || result?.isFinal == true { self.stop() }
                }
            }
        } catch {
            message = "Microphone unavailable: \(error.localizedDescription)"
            stop()
        }
    }

    func stop() {
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        isListening = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

@MainActor
final class VoiceOutput: ObservableObject {
    @Published var speaking = false
    private let synthesizer = AVSpeechSynthesizer()

    func speak(_ text: String) {
        synthesizer.stopSpeaking(at: .immediate)
        guard !text.isEmpty else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
        let utterance = AVSpeechUtterance(string: String(text.prefix(6000)))
        utterance.rate = 0.51
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        synthesizer.speak(utterance)
        speaking = true
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        speaking = false
    }
}
