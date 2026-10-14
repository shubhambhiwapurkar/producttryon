"""Image helpers: storage on local disk, normalising uploads, watermarking."""

import io
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps, UnidentifiedImageError

from . import config


class InvalidImage(ValueError):
    pass


def load_image(data: bytes) -> Image.Image:
    """Decode an upload, apply the phone's EXIF rotation and convert to RGB(A)."""
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise InvalidImage("Not a readable image") from exc
    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() or img.mode == "P" else "RGB")
    return img


def fit(img: Image.Image, max_side: int = config.RENDER_MAX_SIDE) -> Image.Image:
    img = img.copy()
    img.thumbnail((max_side, max_side), Image.LANCZOS)
    return img


def to_jpeg(img: Image.Image, quality: int = 90) -> bytes:
    if img.mode == "RGBA":
        bg = Image.new("RGB", img.size, "white")
        bg.paste(img, mask=img.getchannel("A"))
        img = bg
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def save_image(data: bytes, folder: str, max_side: int = 2048) -> str:
    """Validate, normalise and store an image. Returns a path relative to MEDIA_DIR."""
    img = fit(load_image(data), max_side)
    rel = Path(folder) / f"{uuid.uuid4().hex}.jpg"
    dest = config.MEDIA_DIR / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(to_jpeg(img))
    return rel.as_posix()


def read_media(rel_path: str) -> bytes:
    return (config.MEDIA_DIR / rel_path).read_bytes()


def delete_media(rel_path: str | None) -> None:
    if rel_path:
        (config.MEDIA_DIR / rel_path).unlink(missing_ok=True)


def watermark(img: Image.Image, text: str = "AI preview - actual piece may vary") -> Image.Image:
    img = img.convert("RGB")
    draw = ImageDraw.Draw(img, "RGBA")
    size = max(12, img.width // 45)
    try:
        from PIL import ImageFont

        font = ImageFont.load_default(size=size)
    except TypeError:
        font = None
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    pad = size // 2
    x = img.width - (right - left) - 2 * pad
    y = img.height - (bottom - top) - 2 * pad
    draw.rectangle([x - pad, y - pad, img.width, img.height], fill=(0, 0, 0, 110))
    draw.text((x, y - top), text, fill=(255, 255, 255, 230), font=font)
    return img
