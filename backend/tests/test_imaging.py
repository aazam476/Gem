from __future__ import annotations

import base64
import io

import pytest
from PIL import Image

from app.imaging import ImageError, prepare_image

from .conftest import jpeg_b64


def test_resizes_by_long_edge_preserving_aspect() -> None:
    img = prepare_image(jpeg_b64(size=(2000, 1000)), max_bytes=10_000_000, long_edge=1024)
    assert (img.width, img.height) == (2000, 1000)  # original dims are reported
    with Image.open(io.BytesIO(img.jpeg)) as out:
        assert out.size == (1024, 512)


def test_small_images_not_upscaled() -> None:
    img = prepare_image(jpeg_b64(size=(300, 200)), max_bytes=10_000_000, long_edge=1024)
    with Image.open(io.BytesIO(img.jpeg)) as out:
        assert out.size == (300, 200)


def test_data_url_prefix_accepted() -> None:
    prepare_image("data:image/jpeg;base64," + jpeg_b64(), max_bytes=10_000_000, long_edge=512)


@pytest.mark.parametrize("data", ["", "!!!notbase64", base64.b64encode(b"not an image").decode()])
def test_garbage_refused(data: str) -> None:
    with pytest.raises(ImageError):
        prepare_image(data, max_bytes=10_000_000, long_edge=512)


def test_too_large_refused() -> None:
    with pytest.raises(ImageError):
        prepare_image(jpeg_b64(size=(1000, 1000)), max_bytes=100, long_edge=512)


def test_dark_frame_has_low_luma() -> None:
    assert prepare_image(jpeg_b64((0, 0, 0)), max_bytes=10**7, long_edge=256).mean_luma < 12
