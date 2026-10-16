#!/usr/bin/env python3
"""Assemble a VANTA iOS target on top of MIT-licensed MOVD video diffusion.

This does not simulate video generation. All upstream inference code is preserved.
A built app REQUIRES downloaded Core ML model weights; absent weights cause a
hard failure rather than a fake 'working' generator.
"""
import argparse
import re
import shutil
import sys
from pathlib import Path

UPSTREAM_APP = Path('On-Device-MOVD-Sora/On-Device-MOVD-Sora')
REQUIRED_MODEL_FILES = {
    'tokenizer.json', 'tokenizer_config.json', 't5embed-tokens',
    't5final-layer-norm', 'stdit3_part1', 'stdit3_part2',
    'vae_spatial_part1', 'vae_temporal_part1',
    *[f't5block-layer{i}' for i in range(24)],
    *[f'stdit3_ST_{i}' for i in range(28)],
}
# These types are named explicitly by upstream VAEDecoder and MUST have
# source .mlpackage files available at Xcode compilation time.
VAE_NAMES = [
    'vae_temporal_part1', 'vae_temporal_part2_1', 'vae_temporal_part2_2',
    'vae_temporal_part2_3_1', 'vae_temporal_part2_3_2',
    'vae_temporal_part2_3_3', 'vae_temporal_part2_3_4',
    'vae_temporal_part2_4', 'vae_temporal_part3',
    'vae_spatial_part1', 'vae_spatial_part2', 'vae_spatial_part3_1',
    'vae_spatial_part3_2', 'vae_spatial_part3_3',
    'vae_spatial_part3_4_1', 'vae_spatial_part3_4_2',
    'vae_spatial_part3_4_3', 'vae_spatial_part4',
]


def must_replace(original: str, old: str, new: str, desc: str) -> str:
    if old not in original:
        raise ValueError(f'Upstream MOVD source changed; cannot safely apply {desc} patch')
    return original.replace(old, new, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--movd', required=True, help='Cloned official https://github.com/eai-lab/MOVD root')
    ap.add_argument('--models', required=True, help='Folder containing converted .mlpackage weights and tokenizers')
    ap.add_argument('--output', required=True)
    ap.add_argument('--kit', default=str(Path(__file__).resolve().parents[1]))
    ap.add_argument('--source-only-check', action='store_true', help='Validate assembly structure without any model files. NOT build-ready!')
    args = ap.parse_args()
    kit, movd, modelroot, out = map(Path, (args.kit, args.movd, args.models, args.output))
    upstream = movd / UPSTREAM_APP
    target = out / 'On-Device-MOVD-Sora'
    project = out / 'On-Device-MOVD-Sora.xcodeproj' / 'project.pbxproj'

    for file in (upstream / 'SoraPipeline.swift', upstream / 'Tensor2Vid.swift', upstream / 'ContentView.swift',
                 movd / 'On-Device-MOVD-Sora' / 'On-Device-MOVD-Sora.xcodeproj' / 'project.pbxproj'):
        if not file.exists():
            raise SystemExit(f'Missing upstream MOVD file: {file}')
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(movd / 'On-Device-MOVD-Sora', out, ignore=shutil.ignore_patterns('.DS_Store', '.git', 'DerivedData'))

    # Keep MOVD's entire T5 -> STDiT -> VAE inference stack and Swift package dependencies.
    for file in (kit / 'VANTA_ONE').glob('*.swift'):
        if file.name in {'VantaOneApp.swift', 'MainTabView.swift', 'AboutView.swift'}:
            continue
        shutil.copy2(file, target / file.name)
    theme_source = (kit / 'VANTA_ONE' / 'VantaOneApp.swift').read_text()
    start = theme_source.find('enum Theme {')
    if start < 0:
        raise SystemExit('VANTA theme definition not found')
    (target / 'Theme.swift').write_text('import SwiftUI\n' + theme_source[start:])

    main_tabs = (kit / 'VANTA_ONE' / 'MainTabView.swift').read_text()
    needle = '        TabView {\n'
    main_tabs = must_replace(main_tabs, needle,
       '        TabView {\n            NavigationStack { VideoStudioView() }\n'
       '                .tabItem { Label("AI Video", systemImage: "video.fill") }\n', 'video tab')
    (target / 'MainTabView.swift').write_text(main_tabs)

    about = (kit / 'VANTA_ONE' / 'AboutView.swift').read_text()
    about = about.replace('Text("VANTA ONE • VERSION 1.0 • MADE TO BE FREE")',
                          'Text("VANTA ONE • VIDEO RESEARCH BUILD • FREE")')
    about = about.replace('Text generation uses Foundation Models. Image generation uses Image Playground. Text from photos uses Vision. Dictation requests on-device recognition.',
                          'Video uses MOVD T5/STDiT/VAE diffusion on the iPhone. Chat uses Foundation Models; images use Image Playground; OCR uses Vision.')
    about = about.replace('It cannot automatically browse the live web, run external apps, create Grok-quality video, or answer every possible request. Image Playground has its own styles and restrictions.',
                          'MOVD produces very short silent low-resolution videos slowly; it is not Grok-quality video, 60-second output, audio synthesis, or image-to-video. The iPhone 16 has not been hardware-tested with this build.')
    (target / 'AboutView.swift').write_text(about)

    for src in (kit / 'VIDEO_ENGINE').glob('*.swift'):
        shutil.copy2(src, target / src.name)

    # Fixed output instead of overwriting sample.mp4 on every generation.
    tensorfile = target / 'Tensor2Vid.swift'
    tensor = tensorfile.read_text()
    tensor = must_replace(tensor,
        '        let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("sample.mp4")',
        '        let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]\n'
        '            .appendingPathComponent("VantaVideos", isDirectory: true)\n'
        '        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)\n'
        '        let outputURL = folder.appendingPathComponent("vanta-\\(UUID().uuidString).mp4")',
        'unique persistent MP4 output')
    tensor = must_replace(tensor,
        '    @Published var videoURL: URL?',
        '    @Published var videoURL: URL?\n    @Published var errorMessage: String?',
        'failure reporting')
    tensorfile.write_text(tensor)

    # The upstream prototype only prints some errors. Surface them to the UI.
    sora_path = target / 'SoraPipeline.swift'
    sora = sora_path.read_text()
    sora = must_replace(sora,
        '              print("Error: Can\'t tokenize")\n              return',
        '               print("Error: Can\'t tokenize")\n'
        '               await MainActor.run { Converter?.errorMessage = "The text encoder could not tokenize this prompt." }\n'
        '               return', 'tokenization errors') if '               print("Error: Can\'t tokenize")\n               return' in sora else sora
    # Guard missing model output before attempting a force-unwrapped STDiT.
    sora = must_replace(sora,
        '          let rflowInput = RFLOWInput(model: STDiT!,',
        '           guard let model = STDiT else {\n'
        '             await MainActor.run { Converter?.errorMessage = "Missing MOVD video diffusion model files." }\n'
        '             return\n'
        '           }\n'
        '           let rflowInput = RFLOWInput(model: model,', 'missing STDiT guard')
    sora = must_replace(sora,
        '          print("Error: Can\'t make sample.")\n          print(error)',
        '           print("Error: Can\'t make sample.")\n           print(error)\n'
        '           await MainActor.run { Converter?.errorMessage = error.localizedDescription }',
        'visible inference failure')
    sora = must_replace(sora,
        '          let _ = await Converter!.convertToVideo(multiArray: resultDecoding, logdir: logdir, filename: filename)',
        '           let output = await Converter!.convertToVideo(multiArray: resultDecoding, logdir: logdir, filename: filename)\n'
        '           if output == nil {\n'
        '             await MainActor.run { Converter?.errorMessage = "Video encoding failed." }\n'
        '           }', 'MP4 encoding failure')
    sora_path.write_text(sora)

    # Boot into VANTA's tabs, not MOVD's unbranded demonstration screen.
    appfile = target / 'On_Device_MOVD_SoraApp.swift'
    appcode = appfile.read_text()
    appcode = must_replace(appcode, '    var body: some Scene {',
        '    @StateObject private var workspace = WorkspaceStore()\\n\\n    var body: some Scene {'.replace('\\n', '\n'),
        'workspace state')
    appcode = must_replace(appcode, '            ContentView()',
        '            MainTabView()\\n                .environmentObject(workspace)\\n                .preferredColorScheme(.dark)'.replace('\\n','\n'),
        'VANTA main screen')
    appfile.write_text(appcode)

    # Preserve the bundled app icon. MOVD's Xcode project uses a synchronized root group.
    shutil.rmtree(target / 'Assets.xcassets', ignore_errors=True)
    shutil.copytree(kit / 'Assets.xcassets', target / 'Assets.xcassets')

    project_content = project.read_text()
    project_content, version_hits = re.subn(r'IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;', 'IPHONEOS_DEPLOYMENT_TARGET = 26.0;', project_content)
    if version_hits < 1:
        raise SystemExit('Unrecognized MOVD project deployment setting')
    # Keep Swift module unchanged: upstream SoraPipeline has references
    # to On_Device_MOVD_Sora.STDiT and requires that module name.
    project_content = project_content.replace('INFOPLIST_KEY_CFBundleDisplayName = "On-Device-MOVD-Sora";',
                                               'INFOPLIST_KEY_CFBundleDisplayName = "VANTA ONE";')
    project_content = re.sub(r'PRODUCT_BUNDLE_IDENTIFIER = [^;]+;',
                             'PRODUCT_BUNDLE_IDENTIFIER = app.vantaone.video.private;', project_content)
    if 'INFOPLIST_KEY_NSPhotoLibraryUsageDescription' not in project_content:
        project_content = project_content.replace('GENERATE_INFOPLIST_FILE = YES;',
           'GENERATE_INFOPLIST_FILE = YES;\n'
           '                INFOPLIST_KEY_CFBundleDisplayName = "VANTA ONE";\n'
           '                INFOPLIST_KEY_NSMicrophoneUsageDescription = "Allow voice input.";\n'
           '                INFOPLIST_KEY_NSSpeechRecognitionUsageDescription = "Transcribe spoken prompts.";\n'
           '                INFOPLIST_KEY_NSPhotoLibraryUsageDescription = "Read photos you choose for AI chat and image creation.";')
    project.write_text(project_content)

    if not args.source_only_check:
        if not modelroot.exists():
            raise SystemExit(f'Model folder not found: {modelroot}')
        seen = set()
        # The public weights are structured as Xcode .mlpackage folders. Preserve
        # each package as a directory; flatten nested download folders at app root.
        for candidate in modelroot.rglob('*'):
            if not candidate.is_dir() or candidate.suffix.lower() not in {'.mlpackage', '.mlmodelc'}:
                continue
            name = candidate.stem
            if name in seen:
                continue
            seen.add(name)
            shutil.copytree(candidate, target / candidate.name)
        for file in modelroot.rglob('*'):
            if file.is_file() and file.name in {'tokenizer.json', 'tokenizer_config.json'}:
                shutil.copy2(file, target / file.name)
                seen.add(file.name)
        # Do NOT copy loose model.mlmodel files nested inside .mlpackage
        # directories. They refer to sibling Data/.../weights/weight.bin files,
        # so copying them alone creates a broken orphan model in Xcode.
        seen.update(p.name for p in target.iterdir() if p.is_file() and p.name in {'tokenizer.json', 'tokenizer_config.json'})
        missing = sorted(REQUIRED_MODEL_FILES - seen)
        missing_vaes = sorted(set(VAE_NAMES) - {p.stem for p in target.glob('*.mlpackage')})
        if missing or missing_vaes:
            print('Model files absent. Cannot create an actual MOVD video-generating iPhone build.')
            print('Required model files missing (first 35):', (missing + missing_vaes)[:35])
            print('Download official models from https://drive.google.com/drive/folders/1L6pVi3KmyLygR_pvKofRL-21adKsEb4p')
            raise SystemExit(2)
    else:
        print('WARNING: --source-only-check did NOT add model weights. Output is not a buildable video app.')

    print(f'Prepared real VANTA/MOVD video iPhone source at: {out}')
    print('Video engine: upstream MOVD T5/STDiT/VAE. No mock generator or cloud API.')


if __name__ == '__main__':
    main()
