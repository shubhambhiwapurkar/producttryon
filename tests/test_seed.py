import pytest
from PIL import Image
from sqlalchemy import select

from app import config, db
from scripts.seed_from_folder import SeedError, seed


@pytest.fixture
def media_dir(tmp_path, monkeypatch):
    media = tmp_path / "media"
    monkeypatch.setattr(config, "MEDIA_DIR", media)
    db.init_db(f"sqlite:///{tmp_path}/t.db")
    return media


def write_image(path, color=(200, 150, 90)):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (120, 160), color).save(path)


def load_products():
    """(name, category, source, image paths) for every product in the database."""
    with db.SessionLocal() as session:
        products = session.scalars(select(db.Product).order_by(db.Product.id)).all()
        return [
            (p.name, p.category, p.source, [img.path for img in p.images])
            for p in products
        ]


def test_category_folders_one_product_per_image(tmp_path, media_dir):
    src = tmp_path / "src"
    write_image(src / "necklaces" / "gold_chain.jpg")
    write_image(src / "necklaces" / "pearl-set.png")
    write_image(src / "Earrings" / "jhumka.jpeg")
    (src / "Earrings" / "broken.jpg").write_bytes(b"not an image")

    result = seed(src, "demo", limit=200, create_name="Demo Jewellers")

    products = load_products()
    assert sorted((name, category) for name, category, _, _ in products) == [
        ("Gold Chain", "necklace"),
        ("Jhumka", "earrings"),
        ("Pearl Set", "necklace"),
    ]
    assert {source for _, _, source, _ in products} == {"dataset"}
    assert result.created == {"necklace": 2, "earrings": 1}
    assert len(result.skipped) == 1 and "broken.jpg" in result.skipped[0]
    for _, _, _, paths in products:
        assert len(paths) == 1
        assert (media_dir / paths[0]).is_file()


def test_product_folders_group_angles_and_cap_at_max(tmp_path, media_dir):
    src = tmp_path / "src"
    for angle in ["back.jpg", "front.jpg", "side.jpg"]:
        write_image(src / "rings" / "Solitaire Ring" / angle)
    for i in range(config.MAX_PRODUCT_IMAGES + 2):
        write_image(src / "rings" / "Band_Set" / f"angle_{i:02d}.jpg")

    result = seed(src, "demo", limit=200, create_name="Demo Jewellers")

    products = load_products()
    assert [(name, category) for name, category, _, _ in products] == [
        ("Band Set", "ring"),
        ("Solitaire Ring", "ring"),
    ]
    band, solitaire = products[0][3], products[1][3]
    assert len(band) == config.MAX_PRODUCT_IMAGES
    assert len(solitaire) == 3
    assert result.created == {"ring": 2}
    assert result.skipped == []


def test_missing_store_without_create_fails(tmp_path, media_dir):
    with pytest.raises(SeedError, match="does not exist"):
        seed(tmp_path, "nope")
