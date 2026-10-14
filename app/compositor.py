"""Landmark-guided compositor ("mode B" in PLAN.md).

Places the jeweller's own product photo on the customer's photo, so the design
is reproduced exactly and no AI model is needed. It finds the face with OpenCV's
bundled Haar cascade, cuts the piece out of its light studio background, then
positions, scales and shadows it by category. Earrings are split into the left
and right piece of the pair and hung from each ear lobe.

Categories without a face anchor (rings, bracelets, bangles, anklets) are
passed to the fallback renderer.
"""

import re

import cv2
import numpy as np
from PIL import Image, ImageFilter

from .renderers import MockRenderer, RenderError, RenderRequest

# Face box from the Haar cascade, in pixels.
Box = tuple[int, int, int, int]

# Rough height of the Haar face box (brow to chin) in centimetres, used to turn
# product dimensions such as "Drop 4.5 cm" into pixels.
FACE_BOX_CM = 12.0

_cascade = None


def detect_face(img: Image.Image) -> Box | None:
    global _cascade
    if _cascade is None:
        _cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    gray = cv2.equalizeHist(cv2.cvtColor(np.asarray(img.convert("RGB")), cv2.COLOR_RGB2GRAY))
    min_side = max(40, min(img.size) // 10)
    faces = _cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(min_side, min_side))
    if len(faces) == 0:
        return None
    x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
    return int(x), int(y), int(w), int(h)


def cutout(product: Image.Image) -> Image.Image:
    """Product photo → RGBA with the studio background made transparent."""
    rgba = product.convert("RGBA")
    arr = np.asarray(rgba).astype(np.int16)
    if arr[..., 3].min() < 250:  # already has transparency
        alpha = arr[..., 3].astype(np.float32)
    else:
        rgb = arr[..., :3]
        k = max(4, min(rgb.shape[:2]) // 40)
        corners = np.concatenate([rgb[:k, :k], rgb[:k, -k:], rgb[-k:, :k], rgb[-k:, -k:]]).reshape(-1, 3)
        bg = np.median(corners, axis=0)
        diff = np.abs(rgb - bg).max(axis=2).astype(np.float32)
        # Studio backgrounds carry soft gradients and drop shadows; only clear
        # departures from the background colour count as the piece.
        alpha = np.clip((diff - 24) * (255 / 36), 0, 255)
    alpha[alpha < 70] = 0  # drop faint background haze so it doesn't show as a box
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0)
    out = np.dstack([arr[..., :3], alpha]).astype(np.uint8)
    img = Image.fromarray(out, "RGBA")
    box = img.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox()
    if box is None:
        raise RenderError("Could not separate the piece from its background")
    return img.crop(box)


def split_pair(piece: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Split a photo of an earring pair into (left, right) pieces at the widest
    empty column gap near the middle; falls back to the midpoint."""
    alpha = np.asarray(piece.getchannel("A")) > 40
    cols = alpha.any(axis=0)
    w = len(cols)
    lo, hi = int(w * 0.25), int(w * 0.75)
    best, run, best_mid = 0, 0, w // 2
    for i in range(lo, hi):
        run = run + 1 if not cols[i] else 0
        if run > best:
            best, best_mid = run, i - run // 2
    halves = []
    for part in (piece.crop((0, 0, best_mid, piece.height)), piece.crop((best_mid, 0, w, piece.height))):
        box = part.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox()
        halves.append(part.crop(box) if box else part)
    return halves[0], halves[1]


def size_cm(details: str | None) -> float | None:
    match = re.search(r"(\d+(?:\.\d+)?)\s*cm", details or "")
    return float(match.group(1)) if match else None


def resize_to(piece: Image.Image, *, height: float | None = None, width: float | None = None) -> Image.Image:
    scale = height / piece.height if height else width / piece.width
    return piece.resize((max(4, round(piece.width * scale)), max(4, round(piece.height * scale))), Image.LANCZOS)


def place(base: Image.Image, piece: Image.Image, x: float, y: float) -> None:
    """Paste piece with its top-left at (x, y), with a soft contact shadow."""
    pos = (round(x), round(y))
    alpha = piece.getchannel("A")
    blur = max(2, piece.width // 25)
    shadow = Image.new("RGBA", piece.size, (40, 25, 15, 0))
    shadow.putalpha(alpha.filter(ImageFilter.GaussianBlur(blur)).point(lambda v: int(v * 0.35)))
    offset = max(1, piece.width // 30)
    base.alpha_composite(shadow, (pos[0] + offset, pos[1] + offset * 2))
    base.alpha_composite(piece, pos)


class CompositeRenderer:
    name = "composite"

    def __init__(self, fallback=None):
        self.fallback = fallback or MockRenderer()

    def render(self, req: RenderRequest) -> Image.Image:
        handler = {
            "earrings": self._earrings,
            "necklace": self._necklace,
            "pendant": self._necklace,
            "maang_tikka": self._maang_tikka,
            "nose_pin": self._nose_pin,
        }.get(req.category)
        if handler is None:
            return self.fallback.render(req)
        face = detect_face(req.person)
        if face is None:
            raise RenderError("No face found. Use a front-facing photo with the face clearly visible.")
        base = req.person.convert("RGBA")
        handler(base, cutout(req.product_images[0]), face, req)
        return base.convert("RGB")

    def _earrings(self, base, piece, face, req) -> None:
        x, y, w, h = face
        left, right = split_pair(piece)
        cm = size_cm(req.product_details)
        is_drop = left.height > left.width * 1.4
        if cm:
            target_h = float(np.clip(cm * h / FACE_BOX_CM, 0.08 * h, 0.75 * h))
            # A stated diameter refers to the width of a stud or hoop.
            sized = [resize_to(p, height=target_h) if is_drop else resize_to(p, width=target_h) for p in (left, right)]
        elif is_drop:
            sized = [resize_to(p, height=0.42 * h) for p in (left, right)]
        else:
            sized = [resize_to(p, width=0.16 * w) for p in (left, right)]
        lobe_y = y + 0.70 * h
        for piece_, ear_x in zip(sized, (x - 0.02 * w, x + w * 1.02)):
            # Small studs sit centred on the lobe; drops and hoops hang from it.
            hangs = is_drop or piece_.height > 0.18 * h
            top = lobe_y - (piece_.height * 0.08 if hangs else piece_.height / 2)
            place(base, piece_, ear_x - piece_.width / 2, top)

    def _necklace(self, base, piece, face, req) -> None:
        x, y, w, h = face
        width = (0.75 if req.category == "pendant" else 1.35) * w
        piece = resize_to(piece, width=width)
        place(base, piece, x + w / 2 - piece.width / 2, y + 1.18 * h)

    def _maang_tikka(self, base, piece, face, req) -> None:
        x, y, w, h = face
        piece = resize_to(piece, width=0.16 * w)
        place(base, piece, x + w / 2 - piece.width / 2, y - 0.08 * h)

    def _nose_pin(self, base, piece, face, req) -> None:
        x, y, w, h = face
        piece = resize_to(piece, width=0.06 * w)
        place(base, piece, x + 0.58 * w - piece.width / 2, y + 0.60 * h)
