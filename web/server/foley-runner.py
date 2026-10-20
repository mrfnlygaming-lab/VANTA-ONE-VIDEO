#!/usr/bin/env python
import argparse
import os
import sys

# The Foley repo is the process cwd. Put it first so we import the user's
# repaired official source, not a stale global copy.
sys.path.insert(0, os.getcwd())

import torch
import torchaudio

from hunyuanvideo_foley.utils.model_utils import load_model
from infer import infer as foley_infer, set_manual_seed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model_path", required=True)
    parser.add_argument("--model_size", choices=["xl", "xxl"], default="xl")
    parser.add_argument("--single_video", required=True)
    parser.add_argument("--single_prompt", required=True)
    parser.add_argument("--output_audio", required=True)
    parser.add_argument("--num_inference_steps", type=int, default=12)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--gpu_id", type=int, default=0)
    parser.add_argument("--enable_offload", action="store_true")
    args = parser.parse_args()

    set_manual_seed(1)

    if args.device == "cuda":
        device = torch.device(f"cuda:{args.gpu_id}")
    else:
        device = torch.device(args.device)

    root = os.getcwd()
    config_path = os.path.join(
        root,
        "configs",
        f"hunyuanvideo-foley-{args.model_size}.yaml",
    )

    if not os.path.isfile(config_path):
        raise FileNotFoundError(f"Foley config not found: {config_path}")
    if not os.path.isfile(args.single_video):
        raise FileNotFoundError(f"Input video not found: {args.single_video}")

    model_dict, cfg = load_model(
        args.model_path,
        config_path,
        device,
        enable_offload=args.enable_offload,
        model_size=args.model_size,
    )

    audio, sample_rate = foley_infer(
        args.single_video,
        args.single_prompt,
        model_dict,
        cfg,
        num_inference_steps=args.num_inference_steps,
    )

    os.makedirs(os.path.dirname(args.output_audio), exist_ok=True)
    torchaudio.save(args.output_audio, audio, sample_rate)
    print(f"VANTA_FOLEY_AUDIO={args.output_audio}")


if __name__ == "__main__":
    main()
