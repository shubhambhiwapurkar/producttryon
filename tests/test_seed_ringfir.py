import re

import pytest
from PIL import Image, ImageDraw
from sqlalchemy import select

from app import config, db
from scripts.create_store import StoreError
from scripts.seed_ringfir import SeedError, seed

GOLD = (212, 175, 55)


@pytest.fixture
def media_dir(tmp_path, monkeypatch):
    media = tmp_path / "media"
    monkeypatch.setattr(config, "MEDIA_DIR", media)
    db.init_db(f"sqlite:///{tmp_path}/t.db")
    return media


def make_png(path, background, transparent=False):
    """512x512 image: a gold disc on the given background (RGBA when transparent)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGBA" if transparent else "RGB", (512, 512), background)
    ImageDraw.Draw(img).ellipse((160, 160, 352, 352), fill=GOLD + (255,) if transparent else GOLD)
    img.save(path)


def make_tree(repo):
    """Fake clone: <repo>/data/RingFIR with a light, a dark and a transparent class."""
    ringfir = repo / "data" / "RingFIR"
    make_png(ringfir / "001" / "001_001.png", (255, 255, 255))  # light
    make_png(ringfir / "002" / "002_001.png", (0, 0, 0))  # dark
    make_png(ringfir / "003" / "003_001.png", (0, 0, 0, 0), transparent=True)  # transparent, light after compositing
    return ringfir


def load_products():
    with db.SessionLocal() as session:
        products = session.scalars(select(db.Product).order_by(db.Product.id)).all()
        return [
            {
                "name": p.name,
                "category": p.category,
                "price": p.price,
                "currency": p.currency,
                "dimensions": p.dimensions,
                "description": p.description,
                "source": p.source,
                "images": [(img.path, img.angle, img.position) for img in p.images],
            }
            for p in products
        ]


def test_default_skips_dark_and_uses_curated_names(tmp_path, media_dir):
    make_tree(tmp_path / "repo")

    result = seed(tmp_path / "repo", "demo", create_name="Maison Demo Jewellers")

    assert result["created_store"] is True
    assert result["created"] == 2 and result["skipped"] == 0
    assert result["names"] == ["Diamond Teardrop Drops", "Diamond Crossover Studs"]
    products = load_products()
    assert [p["name"] for p in products] == ["Diamond Teardrop Drops", "Diamond Crossover Studs"]
    with db.SessionLocal() as session:
        store = session.scalar(select(db.Store).where(db.Store.slug == "demo"))
        assert store.name == "Maison Demo Jewellers"
        assert store.whatsapp_number == "+91 98765 43210"


def test_include_dark_adds_dark_product(tmp_path, media_dir):
    make_tree(tmp_path / "repo")

    result = seed(tmp_path / "repo", "demo", create_name="Maison Demo Jewellers", include_dark=True)

    assert result["names"] == ["Diamond Teardrop Drops", "Diamond Line Drops", "Diamond Crossover Studs"]


def test_product_fields_and_images(tmp_path, media_dir):
    make_tree(tmp_path / "repo")
    seed(tmp_path / "repo", "demo", create_name="Maison Demo Jewellers")

    by_name = {p["name"]: p for p in load_products()}
    drops = by_name["Diamond Teardrop Drops"]
    studs = by_name["Diamond Crossover Studs"]
    for product in (drops, studs):
        assert product["category"] == "earrings"
        assert product["currency"] == "INR"
        assert product["source"] == "dataset"
        assert product["description"].endswith("Demo image: RingFIR dataset (MIT).")
        assert int(product["price"]) % 500 == 0
        assert 45000 <= int(product["price"]) <= 165000  # "Diamond" price range
    assert studs["dimensions"] == "Diameter 1.2 cm"
    match = re.fullmatch(r"Drop (\d\.\d) cm", drops["dimensions"])
    assert match and 3.0 <= float(match.group(1)) <= 6.0

    for product in by_name.values():
        ((path, angle, position),) = product["images"]
        assert path.startswith("products/demo/") and path.endswith(".jpg")
        assert (angle, position) == ("front", 0)
        assert (media_dir / path).is_file()


def test_rerun_does_not_duplicate(tmp_path, media_dir):
    make_tree(tmp_path / "repo")
    seed(tmp_path / "repo", "demo", create_name="Maison Demo Jewellers")

    second = seed(tmp_path / "repo", "demo")

    assert second["created"] == 0 and second["skipped"] == 2 and second["names"] == []
    assert len(load_products()) == 2
    assert len(list(media_dir.rglob("*.jpg"))) == 2  # no orphaned image files


def test_accepts_dataset_folder_directly(tmp_path, media_dir):
    ringfir = make_tree(tmp_path / "repo")

    result = seed(ringfir, "demo", create_name="Maison Demo Jewellers")

    assert result["created"] == 2


def test_per_style_adds_roman_suffix_and_unlisted_name(tmp_path, media_dir):
    ringfir = make_tree(tmp_path / "repo")
    make_png(ringfir / "001" / "001_002.png", (255, 255, 255))
    make_png(ringfir / "099" / "099_001.png", (255, 255, 255))  # not in the curated dict

    result = seed(ringfir, "demo", create_name="Maison Demo Jewellers", per_style=2)

    assert result["names"] == [
        "Diamond Teardrop Drops",
        "Diamond Teardrop Drops II",
        "Diamond Crossover Studs",
        "Gold Earrings 099",
    ]


def test_missing_store_without_create_raises(tmp_path, media_dir):
    make_tree(tmp_path / "repo")

    with pytest.raises(SeedError, match="--create"):
        seed(tmp_path / "repo", "demo")


def test_bad_dataset_path_raises(tmp_path, media_dir):
    with pytest.raises(SeedError, match="no RingFIR class folders"):
        seed(tmp_path / "missing", "demo", create_name="Maison Demo Jewellers")


def test_invalid_store_slug_raises(tmp_path, media_dir):
    make_tree(tmp_path / "repo")

    with pytest.raises(StoreError):
        seed(tmp_path / "repo", "Not A Slug", create_name="Maison Demo Jewellers")
