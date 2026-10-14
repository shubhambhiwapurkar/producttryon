"""Seed a demo store with products from the RingFIR gold earring dataset.

Usage: python -m scripts.seed_ringfir RINGFIR_DIR [--store demo] [--create "Maison Demo Jewellers"]
           [--per-style 1] [--include-dark]

RINGFIR_DIR is the dataset repo root (containing data/RingFIR) or the data/RingFIR folder itself.
Each image is one product (a pair of earrings). By default only images with a light background
are used, since they look right on the storefront.

Dataset: RingFIR (MIT licence), Islam, Joardar & Sekh, CVIP 2020.
"""

import argparse
import io
import random
import sys
from pathlib import Path

from PIL import Image, ImageStat
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db, imaging
from scripts.create_store import StoreError, create_store_record

STYLE_NAMES = {
    "005": "Heart Diamond Studs",
    "007": "Blossom Solitaire Studs",
    "009": "Trefoil Diamond Studs",
    "010": "Emerald Cross Drops",
    "018": "Floral Temple Drops",
    "022": "Enamel Lotus Drops",
    "023": "Swirl Gold Drops",
    "025": "Slender Bead Drops",
    "031": "Ladder Bead Drops",
    "032": "Sculpted Fan Studs",
    "039": "Ruby Bead Drops",
    "044": "Peacock Drops",
    "046": "Enamel Bird Studs",
    "001": "Diamond Teardrop Drops",
    "002": "Diamond Line Drops",
    "003": "Diamond Crossover Studs",
    "004": "Filigree Leaf Drops",
    "006": "Butterfly Diamond Studs",
    "008": "Golden Leaf Studs",
    "011": "Diamond Wave Climbers",
    "012": "Diamond Cluster Studs",
    "013": "Filigree Hook Drops",
    "014": "Classic Gold Hoops",
    "015": "Charm Bali Hoops",
    "016": "Antique Chandbali",
    "019": "Floral Vine Drops",
    "020": "Temple Cone Drops",
    "021": "Filigree Chandelier Drops",
    "024": "Antique Long Drops",
    "026": "Petal Diamond Drops",
    "027": "Blossom Gold Studs",
    "028": "Geometric Zigzag Studs",
    "029": "Trefoil Gold Studs",
    "030": "Temple Bead Drops",
    "033": "Beaded Gold Panels",
    "034": "Pearl Swirl Drops",
    "035": "Filigree Pyramid Studs",
    "036": "Sunburst Studs",
    "037": "Garnet Cabochon Studs",
    "038": "Lakshmi Temple Drops",
    "041": "Ruby Long Drops",
    "042": "Emerald Chandbali",
    "043": "Pearl Chandelier Drops",
    "045": "Temple Jhumka Drops",
    "017": "Gold Jhumka",
    "040": "Bridal Jhumka",
}
# Checked in order; the first keyword found in the product name wins.
DESCRIPTIONS = {
    "Diamond": "Brilliant-cut diamonds set in polished gold for a bright, lasting sparkle.",
    "Temple": "Temple-inspired gold design with a classic, ceremonial character.",
    "Filigree": "Hand-finished 22K gold drops with a fine filigree pattern.",
    "Pearl": "Lustrous pearls framed in warm gold for a soft, timeless glow.",
    "Hoops": "Polished gold hoops with a lightweight, timeless shape.",
    "Studs": "Compact gold studs with a refined finish for everyday wear.",
    "Chandbali": "Sculpted gold chandbalis with a graceful, statement silhouette.",
    "Jhumka": "Traditional bell-shaped gold jhumkas with a festive finish.",
}
DEFAULT_DESCRIPTION = "Handcrafted gold earrings with a refined, classic finish."
DATASET_CREDIT = "Demo image: RingFIR dataset (MIT)."
DEMO_WHATSAPP = "+91 98765 43210"
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
MAX_PER_STYLE = 10
ROMAN_SUFFIXES = ["", " II", " III", " IV", " V", " VI", " VII", " VIII", " IX", " X"]
CORNER_SIZE = 16
LIGHT_THRESHOLD = 235


class SeedError(Exception):
    """The seed run cannot start."""


def find_dataset_root(path: Path) -> Path:
    """The folder holding the class folders: <path>/data/RingFIR, or <path> itself."""
    for candidate in (path / "data" / "RingFIR", path):
        if style_folders(candidate):
            return candidate
    raise SeedError(f"no RingFIR class folders (001..046) found in {path}")


def style_folders(root: Path) -> list[Path]:
    """Numbered class folders inside root, sorted by name."""
    if not root.is_dir():
        return []
    return sorted(p for p in root.iterdir() if p.is_dir() and p.name.isdigit())


def style_images(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS)


def flatten_on_white(img: Image.Image) -> Image.Image:
    """RGB version of img, with any transparency composited onto white."""
    if img.mode in ("RGBA", "LA") or "transparency" in img.info:
        rgba = img.convert("RGBA")
        white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(white, rgba).convert("RGB")
    return img.convert("RGB")


def corner_brightness(data: bytes) -> float:
    """Mean brightness (0-255) of the four corner patches. Raises OSError if data is not an image."""
    with Image.open(io.BytesIO(data)) as img:
        gray = flatten_on_white(img).convert("L")
    w, h = gray.size
    size = min(CORNER_SIZE, w, h)
    corners = [(0, 0), (w - size, 0), (0, h - size), (w - size, h - size)]
    means = [ImageStat.Stat(gray.crop((x, y, x + size, y + size))).mean[0] for x, y in corners]
    return sum(means) / len(means)


def pick_images(folder: Path, per_style: int, include_dark: bool) -> list[tuple[Path, bytes]]:
    """The first `per_style` usable images in a class folder, sorted by file name."""
    chosen: list[tuple[Path, bytes]] = []
    for path in style_images(folder):
        if len(chosen) >= per_style:
            break
        try:
            data = path.read_bytes()
            brightness = corner_brightness(data)
        except (OSError, ValueError):
            continue
        if include_dark or brightness > LIGHT_THRESHOLD:
            chosen.append((path, data))
    return chosen


def product_name(style: str, index: int) -> str:
    """Curated name for a class, with a roman-numeral suffix for later products of the same class."""
    base = STYLE_NAMES.get(style, f"Gold Earrings {style}")
    return base + ROMAN_SUFFIXES[index]


def price_range(name: str) -> tuple[int, int]:
    if "Diamond" in name:
        return 45000, 165000
    if "Hoops" in name or "Studs" in name:
        return 18000, 60000
    return 28000, 120000


def make_price(name: str, rng: random.Random) -> int:
    low, high = price_range(name)
    return round(rng.randint(low, high) / 500) * 500


def make_dimensions(name: str, rng: random.Random) -> str:
    if "Studs" in name:
        return "Diameter 1.2 cm"
    if "Hoops" in name:
        return "Diameter 3 cm"
    return f"Drop {round(rng.uniform(3.0, 6.0), 1)} cm"


def make_description(name: str) -> str:
    sentence = next((text for key, text in DESCRIPTIONS.items() if key in name), DEFAULT_DESCRIPTION)
    return f"{sentence} {DATASET_CREDIT}"


def build_product(store_id: int, store_slug: str, name: str, path: Path, data: bytes) -> db.Product:
    # Price and dimensions depend only on the file name, so reruns give the same values.
    rng = random.Random(path.name)
    price = make_price(name, rng)
    rel = imaging.save_image(data, f"products/{store_slug}")
    return db.Product(
        store_id=store_id,
        name=name,
        category="earrings",
        description=make_description(name),
        price=str(price),
        currency="INR",
        dimensions=make_dimensions(name, rng),
        source="dataset",
        images=[db.ProductImage(path=rel, angle="front", position=0)],
    )


def get_or_create_store(session: Session, slug: str, create_name: str | None) -> tuple[db.Store, bool]:
    """Returns (store, created). Raises SeedError if the store is missing and no name was given."""
    store = session.scalar(select(db.Store).where(db.Store.slug == slug))
    if store is not None:
        return store, False
    if not create_name:
        raise SeedError(f"store '{slug}' does not exist; pass --create \"Store name\" to create it")
    return create_store_record(session, slug, create_name, whatsapp=DEMO_WHATSAPP), True


def seed(
    ringfir_dir: Path | str,
    store_slug: str,
    create_name: str | None = None,
    per_style: int = 1,
    include_dark: bool = False,
) -> dict:
    """Add RingFIR products to a store. Assumes db.init_db() has run.

    Products whose name already exists in the store are skipped. Raises SeedError or StoreError.
    """
    if not 1 <= per_style <= MAX_PER_STYLE:
        raise SeedError(f"per_style must be between 1 and {MAX_PER_STYLE}")
    root = find_dataset_root(Path(ringfir_dir))
    created_names: list[str] = []
    skipped = 0
    with db.SessionLocal() as session:
        store, created_store = get_or_create_store(session, store_slug, create_name)
        existing = set(session.scalars(select(db.Product.name).where(db.Product.store_id == store.id)))
        for folder in style_folders(root):
            for index, (path, data) in enumerate(pick_images(folder, per_style, include_dark)):
                name = product_name(folder.name, index)
                if name in existing:
                    skipped += 1
                    continue
                session.add(build_product(store.id, store.slug, name, path, data))
                existing.add(name)
                created_names.append(name)
        session.commit()
    return {
        "store_slug": store.slug,
        "store_name": store.name,
        "created_store": created_store,
        "created": len(created_names),
        "skipped": skipped,
        "names": created_names,
        "admin_token": store.admin_token,
    }


def print_summary(result: dict) -> None:
    slug = result["store_slug"]
    store_line = f"Store:          {result['store_name']}" + (" (created)" if result["created_store"] else "")
    print(store_line)
    print(f"Created:        {result['created']} products")
    print(f"Skipped:        {result['skipped']} (already in store)")
    print(f"Customer page:  /s/{slug}")
    print(f"Admin page:     /admin/{slug}")
    print(f"Admin token:    {result['admin_token']}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed a store with products from the RingFIR earring dataset.")
    parser.add_argument("ringfir_dir", type=Path, help="RingFIR repo root, or its data/RingFIR folder")
    parser.add_argument("--store", default="demo", help="slug of the store to seed (default: demo)")
    parser.add_argument("--create", metavar="NAME", help="create the store with this name if it does not exist")
    parser.add_argument("--per-style", type=int, default=1, help=f"products per class folder (1-{MAX_PER_STYLE})")
    parser.add_argument("--include-dark", action="store_true", help="also use images with dark backgrounds")
    args = parser.parse_args()
    if not 1 <= args.per_style <= MAX_PER_STYLE:
        parser.error(f"--per-style must be between 1 and {MAX_PER_STYLE}")

    db.init_db()
    try:
        result = seed(args.ringfir_dir, args.store, args.create, args.per_style, args.include_dark)
    except (SeedError, StoreError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
    print_summary(result)


if __name__ == "__main__":
    main()
