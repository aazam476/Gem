"""Draw Gemini's annotations onto the current camera frame (deterministic, no AI)."""

from __future__ import annotations

import io

from PIL import Image, ImageDraw, ImageFont

from .brain import GRID, Annotation

OUTLINE = (255, 214, 0)   # high-visibility yellow
SHADOW = (0, 0, 0)
LABEL_BG = (0, 0, 0)
LABEL_FG = (255, 255, 255)


def _font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # very old Pillow
        return ImageFont.load_default()


def render(jpeg: bytes, annotations: tuple[Annotation, ...] | list[Annotation]) -> tuple[bytes, int, int]:
    with Image.open(io.BytesIO(jpeg)) as src:
        img = src.convert("RGB")
    w, h = img.size
    draw = ImageDraw.Draw(img)
    stroke = max(3, round(min(w, h) / 120))
    font = _font(max(14, round(min(w, h) / 24)))

    for ann in annotations:
        ymin, xmin, ymax, xmax = ann.box_2d
        box = (xmin / GRID * w, ymin / GRID * h, xmax / GRID * w, ymax / GRID * h)
        small = (box[2] - box[0]) < w * 0.04 and (box[3] - box[1]) < h * 0.04
        if small:  # a point: draw a ring around it
            cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
            r = min(w, h) * 0.05
            box = (cx - r, cy - r, cx + r, cy + r)
            draw.ellipse(box, outline=SHADOW, width=stroke + 2)
            draw.ellipse(box, outline=OUTLINE, width=stroke)
        else:
            draw.rectangle(box, outline=SHADOW, width=stroke + 2)
            draw.rectangle(box, outline=OUTLINE, width=stroke)
        if ann.label:
            tl = draw.textbbox((0, 0), ann.label, font=font)
            tw, th = tl[2] - tl[0], tl[3] - tl[1]
            pad = stroke
            x = min(max(0, box[0]), w - tw - 2 * pad)
            y = box[1] - th - 2 * pad - stroke
            if y < 0:
                y = min(h - th - 2 * pad, box[3] + stroke)
            draw.rectangle((x, y, x + tw + 2 * pad, y + th + 2 * pad), fill=LABEL_BG)
            draw.text((x + pad - tl[0], y + pad - tl[1]), ann.label, fill=LABEL_FG, font=font)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue(), w, h
