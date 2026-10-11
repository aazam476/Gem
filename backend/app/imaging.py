"""Decode, sanity-check and downscale uploaded camera frames."""

from __future__ import annotations

import base64
import binascii
import io
from dataclasses import dataclass

from PIL import Image, ImageOps, ImageStat, UnidentifiedImageError

Image.MAX_IMAGE_PIXELS = 40_000_000  # refuse decompression bombs


class ImageError(ValueError):
    pass


@dataclass(frozen=True)
class PreparedImage:
    jpeg: bytes
    width: int  # dimensions after EXIF orientation, before downscale
    height: int
    mean_luma: float


def prepare_image(image_base64: str, *, max_bytes: int, long_edge: int) -> PreparedImage:
    data = image_base64.strip()
    if data.startswith("data:"):
        _, _, data = data.partition(",")
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ImageError("image_base64 is not valid base64") from exc
    if not raw:
        raise ImageError("image is empty")
    if len(raw) > max_bytes:
        raise ImageError(f"image exceeds {max_bytes} bytes")
    try:
        with Image.open(io.BytesIO(raw)) as img:
            img = ImageOps.exif_transpose(img).convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ImageError("could not decode image") from exc

    width, height = img.size
    # Resize by the long edge: preserves aspect ratio so digits are not distorted,
    # and keeps Gemini's normalized 0-1000 box coordinates valid for the original frame.
    img.thumbnail((long_edge, long_edge), Image.Resampling.LANCZOS)
    mean_luma = ImageStat.Stat(img.convert("L")).mean[0]
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return PreparedImage(buf.getvalue(), width, height, mean_luma)
