from __future__ import annotations

import logging
import subprocess

from .config import get_settings

logger = logging.getLogger("app.audio_convert")


class AudioConversionError(Exception):
    pass


def convert_to_mono_flac(input_path: str, output_path: str) -> None:
    """
    Downmix to mono FLAC, preserving the original sample rate.
    Deliberately no -ar flag: we do NOT want to resample.
    """
    settings = get_settings()
    cmd = [
        settings.ffmpeg_binary,
        "-y",
        "-i",
        input_path,
        "-ac",
        "1",
        "-c:a",
        "flac",
        output_path,
    ]

    logger.info("Running ffmpeg: %s", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)

    if proc.returncode != 0:
        logger.error("ffmpeg failed (code %d): %s", proc.returncode, proc.stderr)
        raise AudioConversionError(
            f"ffmpeg conversion failed with exit code {proc.returncode}: {proc.stderr[-2000:]}"
        )
