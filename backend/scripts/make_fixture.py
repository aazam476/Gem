"""Generate the synthetic BP-monitor fixture photo used by tests and the offline demo.

A real photo of a real monitor is still needed for accuracy testing; see
docs/HUMAN_TESTS.md. Run: python scripts/make_fixture.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "fixtures" / "bp_monitor_synthetic.jpg"

# Seven-segment layout: segments a,b,c,d,e,f,g
DIGITS = {
    "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
    "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcfgd",
}


def draw_digit(d: ImageDraw.ImageDraw, ch: str, x: int, y: int, w: int, h: int, t: int, color) -> None:
    half = h // 2
    seg = {
        "a": (x + t, y, x + w - t, y + t),
        "b": (x + w - t, y + t, x + w, y + half),
        "c": (x + w - t, y + half, x + w, y + h - t),
        "d": (x + t, y + h - t, x + w - t, y + h),
        "e": (x, y + half, x + t, y + h - t),
        "f": (x, y + t, x + t, y + half),
        "g": (x + t, y + half - t // 2, x + w - t, y + half + t // 2),
    }
    for s in DIGITS[ch]:
        d.rectangle(seg[s], fill=color)


def draw_number(d, text: str, right: int, y: int, w: int, h: int, t: int, color) -> None:
    x = right
    for ch in reversed(text):
        x -= w + t * 2
        draw_digit(d, ch, x, y, w, h, t, color)


def main() -> None:
    img = Image.new("RGB", (1280, 960), (196, 190, 178))  # table top
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((300, 140, 980, 860), radius=60, fill=(235, 236, 238), outline=(150, 150, 155), width=6)
    d.rounded_rectangle((380, 220, 900, 700), radius=18, fill=(170, 186, 160))  # LCD
    ink = (25, 30, 25)
    draw_number(d, "128", 860, 250, 70, 130, 16, ink)
    draw_number(d, "82", 860, 410, 70, 130, 16, ink)
    draw_number(d, "71", 860, 570, 48, 90, 12, ink)
    d.text((400, 300), "SYS", fill=ink)
    d.text((400, 460), "DIA", fill=ink)
    d.text((400, 600), "PULSE/min", fill=ink)
    d.ellipse((590, 740, 690, 840), fill=(40, 90, 160))  # start button
    img = img.filter(ImageFilter.GaussianBlur(1.2))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, quality=88)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
