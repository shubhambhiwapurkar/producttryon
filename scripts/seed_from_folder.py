"""Load a demo catalogue from a folder of product images.

Usage: python -m scripts.seed_from_folder <folder> --store <slug> [--limit 200] [--create "Demo Jewellers"]

Layouts are detected automatically and can be mixed in one folder:
  a) <folder>/<category>/<image>             one product per image, category from the folder name
  b) <folder>/<category>/<product>/<images>  one product per product folder (angles, sorted by filename)
  c) <folder>/<image>                        one product per image; category from metadata.csv
                                             or inferred from the file name

An optional metadata.csv in <folder> (columns: file, name, category, price, currency, description)
overrides the values for single-image products. `file` is relative to <folder>, or a bare file name.
"""

import argparse
import csv
import re
import sys
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import config, db, imaging
from scripts.create_store import StoreError, create_store_record

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
METADATA_FILE = "metadata.csv"
MAX_SKIPPED_SHOWN = 20

# Keys are folder names lowercased, with spaces/underscores/hyphens removed, and one trailing "s" dropped.
_CATEGORY_ALIASES = {
    "earring": "earrings",
    "necklace": "necklace",
    "ring": "ring",
    "bracelet": "bracelet",
    "bangle": "bangle",
    "pendant": "pendant",
    "anklet": "anklet",
    "nosepin": "nose_pin",
    "maangtikka": "maang_tikka",
    "tikka": "maang_tikka",
    "other": "other",
}


class SeedError(Exception):
    """The seed run cannot start."""


@dataclass
class ProductSpec:
    """A product to create, before its images are validated and saved."""

    name: str
    category: str
    files: list[Path]
    price: str | None = None
    currency: str | None = None
    description: str | None = None


@dataclass
class SeedResult:
    store_slug: str
    created: Counter
    skipped: list[str]

    @property
    def total(self) -> int:
        return sum(self.created.values())


def canonical_category(name: str) -> str | None:
    """Map a folder or CSV category name to one of config.CATEGORIES, or None if unknown."""
    key = re.sub(r"[\s_-]+", "", name.strip().lower())
    for candidate in (key, key.removesuffix("s")):
        if candidate in _CATEGORY_ALIASES:
            return _CATEGORY_ALIASES[candidate]
    return None


def infer_category_safe(text: str) -> str:
    """Guess a category from free text. Falls back to "other" if the importer cannot infer one."""
    # Imported lazily: app.importers is maintained separately and may not be usable yet.
    from app.importers import infer_category

    try:
        category = infer_category(text)
    except NotImplementedError:
        return "other"
    return category if category in config.CATEGORIES else "other"


def folder_category(name: str) -> str:
    return canonical_category(name) or infer_category_safe(name)


def tidy_title(text: str) -> str:
    """Turn 'gold_chain-01' into 'Gold Chain 01'."""
    return " ".join(re.sub(r"[_-]+", " ", text).split()).title()


def _visible(path: Path) -> bool:
    return not path.name.startswith(".") and path.name != "__MACOSX"


def list_images(folder: Path) -> list[Path]:
    """Image files directly inside folder, sorted by file name."""
    return sorted(
        p for p in folder.iterdir()
        if p.is_file() and _visible(p) and p.suffix.lower() in IMAGE_EXTENSIONS
    )


def read_metadata(folder: Path) -> dict[str, dict[str, str]]:
    """Rows of metadata.csv keyed by their `file` value. Empty dict if there is no CSV."""
    path = folder / METADATA_FILE
    if not path.is_file():
        return {}
    rows: dict[str, dict[str, str]] = {}
    with path.open(newline="", encoding="utf-8-sig") as fh:
        for raw in csv.DictReader(fh):
            row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
            key = row.get("file", "").replace("\\", "/")
            if key:
                rows[key] = row
    return rows


def single_image_spec(
    image: Path, folder: Path, default_category: str | None, metadata: dict[str, dict[str, str]]
) -> ProductSpec:
    row = metadata.get(image.relative_to(folder).as_posix()) or metadata.get(image.name) or {}
    name = tidy_title(image.stem)
    category = (
        canonical_category(row.get("category", ""))
        or default_category
        or infer_category_safe(name)
    )
    return ProductSpec(
        name=row.get("name") or name,
        category=category,
        files=[image],
        price=row.get("price") or None,
        currency=row.get("currency") or None,
        description=row.get("description") or None,
    )


def discover(folder: Path) -> Iterator[ProductSpec]:
    """Yield product specs for every layout found under folder."""
    metadata = read_metadata(folder)
    subfolders = sorted(p for p in folder.iterdir() if p.is_dir() and _visible(p))
    for sub in subfolders:
        category = folder_category(sub.name)
        for image in list_images(sub):  # layout a
            yield single_image_spec(image, folder, category, metadata)
        for product_dir in sorted(p for p in sub.iterdir() if p.is_dir() and _visible(p)):  # layout b
            files = list_images(product_dir)[: config.MAX_PRODUCT_IMAGES]
            if files:
                yield ProductSpec(name=tidy_title(product_dir.name), category=category, files=files)
    for image in list_images(folder):  # layout c
        yield single_image_spec(image, folder, None, metadata)


def _get_or_create_store(session: Session, slug: str, create_name: str | None) -> db.Store:
    store = session.scalar(select(db.Store).where(db.Store.slug == slug))
    if store is not None:
        return store
    if not create_name:
        raise SeedError(f"store '{slug}' does not exist; pass --create \"Store name\" to create it")
    return create_store_record(session, slug, create_name)


def _build_product(store_id: int, slug: str, spec: ProductSpec, result: SeedResult) -> db.Product | None:
    """Save the spec's images. Returns None (and records the skips) if no image is usable."""
    images: list[db.ProductImage] = []
    for path in spec.files:
        try:
            rel = imaging.save_image(path.read_bytes(), f"products/{slug}")
        except (imaging.InvalidImage, OSError) as exc:
            result.skipped.append(f"{path}: {exc}")
            continue
        images.append(db.ProductImage(path=rel, position=len(images)))
    if not images:
        return None
    return db.Product(
        store_id=store_id,
        name=spec.name[:300],
        category=spec.category,
        price=spec.price,
        currency=spec.currency,
        description=spec.description,
        source="dataset",
        images=images,
    )


def seed(folder: Path, store_slug: str, limit: int = 200, create_name: str | None = None) -> SeedResult:
    """Import up to `limit` products from folder into the store. Assumes db.init_db() has run."""
    if not folder.is_dir():
        raise SeedError(f"not a folder: {folder}")
    result = SeedResult(store_slug=store_slug, created=Counter(), skipped=[])
    with db.SessionLocal() as session:
        store = _get_or_create_store(session, store_slug, create_name)
        for spec in discover(folder):
            if result.total >= limit:
                break
            product = _build_product(store.id, store_slug, spec, result)
            if product is None:
                continue
            session.add(product)
            result.created[spec.category] += 1
        session.commit()
    return result


def print_summary(result: SeedResult) -> None:
    print(f"Imported {result.total} products into store '{result.store_slug}'")
    for category, count in result.created.most_common():
        print(f"  {category:<12} {count}")
    print(f"Skipped {len(result.skipped)} files")
    for line in result.skipped[:MAX_SKIPPED_SHOWN]:
        print(f"  - {line}")
    if len(result.skipped) > MAX_SKIPPED_SHOWN:
        print(f"  ... and {len(result.skipped) - MAX_SKIPPED_SHOWN} more")


def main() -> None:
    parser = argparse.ArgumentParser(description="Load a demo catalogue from a folder of images.")
    parser.add_argument("folder", type=Path, help="folder with category sub-folders, product folders or flat images")
    parser.add_argument("--store", required=True, help="slug of the store to load into")
    parser.add_argument("--limit", type=int, default=200, help="maximum number of products to create")
    parser.add_argument("--create", metavar="NAME", help="create the store with this name if it does not exist")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be at least 1")

    db.init_db()
    try:
        result = seed(args.folder, args.store, args.limit, args.create)
    except (SeedError, StoreError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
    print_summary(result)


if __name__ == "__main__":
    main()
