#!/usr/bin/env python3
"""Backward-compatible wrapper for the Replay canonicalizer.

The pipeline's implementation now lives under scripts/music-pipeline/
canonicalize/. This entrypoint preserves the original REPLAY_DIR environment
variable and default src/data/music.json output for existing commands.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CANONICALIZE_DIR = os.path.join(HERE, "music-pipeline", "canonicalize")
if CANONICALIZE_DIR not in sys.path:
    sys.path.insert(0, CANONICALIZE_DIR)

from canonicalize import main  # noqa: E402


if __name__ == "__main__":
    replay_dir = os.environ.get("REPLAY_DIR", "/tmp/replay")
    output = os.path.join(HERE, "..", "src", "data", "music.json")
    sys.exit(main(["--input-dir", replay_dir, "--output", output]))
