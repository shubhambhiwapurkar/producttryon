from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from app.compositor import CompositeRenderer, cutout, detect_face, split_pair
from app.renderers import RenderError, RenderRequest

SAMPLE = Path(__file__).resolve().parent.parent / "docs" / "demo" / "sample-customer.jpg"


def earring_pair(size=(512, 512)) -> Image.Image:
    img = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(img)
    for cx in (150, 360):
        d.ellipse([cx - 40, 100, cx + 40, 180], fill=(212, 170, 80))
        d.polygon([(cx, 180), (cx + 30, 330), (cx - 30, 330)], fill=(190, 150, 60))
    return img


def test_cutout_removes_white_background():
    piece = cutout(earring_pair())
    assert piece.mode == "RGBA"
    assert piece.size[0] < 512 and piece.size[1] < 512  # cropped to the piece
    assert piece.getpixel((piece.width // 2, 5))[3] == 0  # gap between the pair is transparent


def test_split_pair_finds_both_earrings():
    left, right = split_pair(cutout(earring_pair()))
    assert abs(left.width - right.width) <= 4
    assert left.height > left.width  # each half is one drop earring


def test_detects_face_on_sample_portrait():
    x, y, w, h = detect_face(Image.open(SAMPLE))
    assert 150 < x < 210 and 40 < y < 100 and w > 60


def test_composite_earrings_changes_only_the_ear_area():
    person = Image.open(SAMPLE).convert("RGB")
    out = CompositeRenderer().render(RenderRequest("earrings", person, [earring_pair()], None, "Drop 4 cm"))
    assert out.size == person.size
    changed = [
        (px, py) for px in range(0, out.width, 4) for py in range(0, out.height, 4)
        if out.getpixel((px, py)) != person.getpixel((px, py))
    ]
    assert changed, "earrings were not drawn"
    xs = [p[0] for p in changed]
    assert min(xs) > 120 and max(xs) < 320  # near the face, not elsewhere in the photo


def test_no_face_raises_helpful_error():
    blank = Image.new("RGB", (400, 400), (200, 200, 200))
    with pytest.raises(RenderError, match="No face"):
        CompositeRenderer().render(RenderRequest("earrings", blank, [earring_pair()]))


def test_rings_fall_back_to_placeholder():
    person = Image.open(SAMPLE).convert("RGB")
    out = CompositeRenderer().render(RenderRequest("ring", person, [earring_pair()]))
    assert out.size == person.size
