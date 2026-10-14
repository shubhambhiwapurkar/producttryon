"""Fetch demo jewellery photos that may be reused commercially.

Why not Google Images: search results are copyrighted by their photographers or
agencies, and showing up in a search is not permission to reuse an image. This script
only downloads images whose licence allows commercial reuse:

  pexels     Pexels licence: free commercial use, no attribution required. Needs a free
             API key from https://www.pexels.com/api/ in PEXELS_API_KEY.
  openverse  Openverse image search filtered to license_type=commercial (CC0, Public
             Domain Mark, CC BY, CC BY-SA). No key needed. The title, creator, licence and
             landing page are kept in the description. CC BY-SA requires share-alike if
             an image is modified and redistributed.

Usage:
  python -m scripts.fetch_demo_photos OUT_DIR [--source pexels|openverse] [--per-query 3] [--models 4]

OUT_DIR receives <category>-<n>.jpg files and a metadata.csv that scripts.seed_from_folder
reads (layout c). Model portraits for try-on tests go to OUT_DIR/_models/ and are not
listed in metadata.csv. OUT_DIR must not already contain a metadata.csv, so one run never
mixes with another.
"""

import argparse
import csv
import io
import math
import os
import random
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import httpx
from PIL import Image

PEXELS_SEARCH_URL = "https://api.pexels.com/v1/search"
OPENVERSE_SEARCH_URL = "https://api.openverse.org/v1/images/"
PEXELS_SITE = "https://www.pexels.com"
USER_AGENT = "producttryon-fetch-demo-photos/1.0"
TIMEOUT = 30.0
JPEG_QUALITY = 90
MAX_NAME_LENGTH = 60
MODELS_DIR = "_models"
METADATA_FILE = "metadata.csv"
METADATA_COLUMNS = ["file", "name", "category", "price", "currency", "description"]
CURRENCY = "INR"
PRICE_SEED = 42
SOURCES = ("pexels", "openverse")

# Search queries per category (jewellery product shots). Keys must be in app.config.CATEGORIES.
PRODUCT_QUERIES: dict[str, list[str]] = {
    "necklace": ["gold necklace jewelry", "diamond necklace", "kundan necklace"],
    "earrings": ["gold earrings jewelry", "jhumka earrings", "diamond earrings"],
    "ring": ["diamond ring", "gold ring jewelry"],
    "bangle": ["gold bangles"],
    "bracelet": ["gold bracelet jewelry"],
    "pendant": ["gold pendant"],
}

# Portrait queries for try-on test models. Saved to MODELS_DIR, not to the catalogue.
MODEL_QUERIES = ["woman portrait neck", "indian woman portrait", "bride portrait jewelry free"]

# Plausible INR price range per category, inclusive. Bounds are multiples of 500.
PRICE_RANGES: dict[str, tuple[int, int]] = {
    "necklace": (40_000, 300_000),
    "earrings": (15_000, 120_000),
    "ring": (25_000, 150_000),
    "bangle": (30_000, 200_000),
    "bracelet": (20_000, 150_000),
    "pendant": (15_000, 100_000),
}


class FetchError(Exception):
    """The fetch cannot start."""


@dataclass
class Photo:
    """One search hit: where to download it, its raw title and the attribution text."""

    id: str
    url: str
    title: str
    attribution: str


@dataclass
class Catalogue:
    rows: list[dict[str, str]]
    models: list[Path]


def warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


def tidy_name(raw: str, fallback: str) -> str:
    """'gold  NECKLACE with pearls' -> 'Gold Necklace With Pearls'. Falls back if empty."""
    name = " ".join(word.capitalize() for word in raw.split())
    if len(name) > MAX_NAME_LENGTH:
        name = name[:MAX_NAME_LENGTH].rsplit(" ", 1)[0].rstrip()
    return name or fallback


def category_label(category: str) -> str:
    return category.replace("_", " ").title()


def openverse_licence(item: dict) -> str:
    """Human-readable licence, e.g. 'CC BY 4.0', 'CC0' or 'Public Domain Mark'."""
    licence = str(item.get("license") or "").lower()
    version = item.get("license_version")
    if licence == "pdm":
        return "Public Domain Mark"
    if licence == "cc0":
        return f"CC0 {version}" if version else "CC0"
    label = f"CC {licence.upper()}" if licence else "an open licence"
    return f"{label} {version}" if version else label


def openverse_photo(item: dict) -> Photo | None:
    if item.get("id") is None or not item.get("url"):
        return None
    title = str(item.get("title") or "")
    creator = str(item.get("creator") or "unknown creator")
    attribution = f'"{title or "Untitled"}" by {creator}, licensed {openverse_licence(item)}'
    landing = item.get("foreign_landing_url")
    if landing:
        attribution += f" ({landing})"
    return Photo(str(item["id"]), str(item["url"]), title, attribution)


def pexels_photo(item: dict) -> Photo | None:
    src = item.get("src") or {}
    url = src.get("large2x") or src.get("large")
    if item.get("id") is None or not url:
        return None
    alt = str(item.get("alt") or "")
    photographer = str(item.get("photographer") or "unknown photographer")
    page = item.get("url") or PEXELS_SITE
    attribution = f'"{alt or "Untitled"}" by {photographer} on Pexels ({page})'
    return Photo(str(item["id"]), str(url), alt, attribution)


def _results(response: httpx.Response, key: str) -> list[dict]:
    payload = response.json()
    items = payload.get(key) if isinstance(payload, dict) else None
    return [item for item in items or [] if isinstance(item, dict)]


def search(
    client: httpx.Client, source: str, query: str, per_page: int, api_key: str
) -> list[Photo]:
    """Photos for one query. A failed search is reported and yields no photos."""
    try:
        if source == "pexels":
            response = client.get(
                PEXELS_SEARCH_URL,
                params={"query": query, "per_page": per_page, "orientation": "portrait"},
                headers={"Authorization": api_key},
            )
            response.raise_for_status()
            items = _results(response, "photos")
            return [photo for item in items if (photo := pexels_photo(item))]
        response = client.get(
            OPENVERSE_SEARCH_URL,
            params={"q": query, "license_type": "commercial", "page_size": per_page, "mature": "false"},
        )
        response.raise_for_status()
        items = _results(response, "results")
        return [photo for item in items if (photo := openverse_photo(item))]
    except (httpx.HTTPError, ValueError) as exc:
        warn(f"search '{query}' failed: {exc}")
        return []


def download_jpeg(client: httpx.Client, url: str) -> bytes | None:
    """Download an image and re-encode it as JPEG. Returns None (after a warning) on failure."""
    try:
        response = client.get(url)
        response.raise_for_status()
        out = io.BytesIO()
        with Image.open(io.BytesIO(response.content)) as image:
            image.convert("RGB").save(out, "JPEG", quality=JPEG_QUALITY)
    except (httpx.HTTPError, OSError, ValueError, Image.DecompressionBombError) as exc:
        warn(f"skipping {url}: {exc}")
        return None
    return out.getvalue()


def random_price(rng: random.Random, category: str) -> int:
    low, high = PRICE_RANGES[category]
    return rng.randrange(low, high + 1, 500)


def fetch_models(
    out_dir: Path,
    source: str,
    models: int,
    client: httpx.Client,
    api_key: str,
    seen: set[str],
) -> list[Path]:
    """Save up to `models` portrait photos into out_dir/_models/."""
    if models == 0:
        return []
    folder = out_dir / MODELS_DIR
    folder.mkdir(exist_ok=True)
    per_query = math.ceil(models / len(MODEL_QUERIES))
    saved: list[Path] = []
    for query in MODEL_QUERIES:
        for photo in search(client, source, query, per_query, api_key):
            if len(saved) == models:
                return saved
            if photo.id in seen:
                continue
            seen.add(photo.id)
            data = download_jpeg(client, photo.url)
            if data is not None:
                path = folder / f"model-{len(saved) + 1}.jpg"
                path.write_bytes(data)
                saved.append(path)
    return saved


def fetch_catalogue(
    out_dir: Path,
    source: str,
    per_query: int,
    models: int,
    client: httpx.Client,
    api_key: str = "",
) -> Catalogue:
    """Download product and model photos into out_dir and return the catalogue rows."""
    if (out_dir / METADATA_FILE).exists():
        raise FetchError(f"{out_dir / METADATA_FILE} already exists; use an empty folder or delete it first")
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(PRICE_SEED)
    seen: set[str] = set()
    counts: Counter[str] = Counter()
    rows: list[dict[str, str]] = []
    for category, queries in PRODUCT_QUERIES.items():
        for query in queries:
            for photo in search(client, source, query, per_query, api_key):
                if photo.id in seen:
                    continue
                seen.add(photo.id)
                data = download_jpeg(client, photo.url)
                if data is None:
                    continue
                counts[category] += 1
                n = counts[category]
                filename = f"{category}-{n}.jpg"
                (out_dir / filename).write_bytes(data)
                rows.append(
                    {
                        "file": filename,
                        "name": tidy_name(photo.title, f"{category_label(category)} {n}"),
                        "category": category,
                        "price": str(random_price(rng, category)),
                        "currency": CURRENCY,
                        "description": photo.attribution,
                    }
                )
    model_paths = fetch_models(out_dir, source, models, client, api_key, seen)
    with (out_dir / METADATA_FILE).open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=METADATA_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    return Catalogue(rows=rows, models=model_paths)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Download demo jewellery photos that allow commercial reuse.")
    parser.add_argument("out_dir", type=Path, help="folder for the photos and metadata.csv (must not have a metadata.csv yet)")
    parser.add_argument(
        "--source",
        choices=SOURCES,
        help="pexels (needs PEXELS_API_KEY) or openverse; default pexels if the key is set, else openverse",
    )
    parser.add_argument("--per-query", type=int, default=3, help="photos requested per product query")
    parser.add_argument("--models", type=int, default=4, help="portrait photos for try-on tests, saved to _models/")
    return parser


def main(argv: list[str] | None = None, client: httpx.Client | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.per_query < 1:
        parser.error("--per-query must be at least 1")
    if args.models < 0:
        parser.error("--models cannot be negative")

    api_key = os.environ.get("PEXELS_API_KEY", "").strip()
    source = args.source or ("pexels" if api_key else "openverse")
    if source == "pexels" and not api_key:
        parser.error("--source pexels needs PEXELS_API_KEY (free key: https://www.pexels.com/api/)")

    owns_client = client is None
    if client is None:
        client = httpx.Client(timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": USER_AGENT})
    try:
        catalogue = fetch_catalogue(args.out_dir, source, args.per_query, args.models, client, api_key)
    except FetchError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        if owns_client:
            client.close()

    print(f"Saved {len(catalogue.rows)} product photos to {args.out_dir} (source: {source})")
    for category, count in Counter(row["category"] for row in catalogue.rows).most_common():
        print(f"  {category:<12} {count}")
    if not catalogue.rows:
        warn("no product photos were saved; check the network, the API key or the queries")
    if catalogue.models:
        print("Model photos for try-on tests (not in metadata.csv):")
        for path in catalogue.models:
            print(f"  {path}")
    print("Next:")
    print(f'python -m scripts.seed_from_folder {args.out_dir} --store demo --create "Demo Jewellers"')


if __name__ == "__main__":
    main()
