"""Pull a jeweller's catalogue from their existing website.

CONTRACT (used by app/main.py and scripts/ — keep these signatures):
    ImportedProduct           dataclass below
    infer_category(text) -> str          one of config.CATEGORIES
    import_from_url(url, limit=50, client=None) -> list[ImportedProduct]
"""

import json
import logging
import re
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

MAX_IMAGES = 8
MAX_DESCRIPTION = 1000
MAX_PAGES = 20  # safety net against sites that ignore the page parameter

# Checked in this order, so the more specific category wins ("pendant with
# chain" is a pendant, "nose ring" a nose pin, "earring" never a ring).
_CATEGORY_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("nose_pin", ("nose pin", "nosepin", "nose ring", "nose stud", "nath")),
    ("earrings", ("earring", "jhumka", "jhumki", "stud", "hoop", "drops", "danglers",
                  "dangler", "chandbali", "ear cuff", "bali")),
    ("maang_tikka", ("maang tikka", "mang tikka", "tikka", "matha patti")),
    ("anklet", ("anklet", "payal", "ankle")),
    ("pendant", ("pendant", "locket")),
    ("bangle", ("bangle", "kada", "kangan", "chudi")),
    ("bracelet", ("bracelet", "cuff")),
    ("necklace", ("necklace", "chain", "choker", "haar", "mangalsutra", "lariat", "collar")),
    ("ring", ("ring", "band", "solitaire")),
]


def _compile_keywords(keywords: Iterable[str]) -> re.Pattern[str]:
    # Whole words only (optional plural), so "ring" never matches "earring" or "string".
    alternatives = "|".join(re.escape(k) for k in keywords)
    return re.compile(rf"(?<![a-z0-9])(?:{alternatives})(?:e?s)?(?![a-z0-9])")


_CATEGORY_PATTERNS = [(cat, _compile_keywords(kws)) for cat, kws in _CATEGORY_KEYWORDS]


@dataclass
class ImportedProduct:
    name: str
    category: str
    image_urls: list[str] = field(default_factory=list)
    description: str | None = None
    price: str | None = None
    currency: str | None = None
    product_url: str | None = None
    platform: str = "generic"  # shopify, woocommerce, generic


def infer_category(text: str) -> str:
    """Guess a jewellery category from free text (title, type, tags, breadcrumb)."""
    normalised = re.sub(r"[^a-z0-9]+", " ", (text or "").lower())
    for category, pattern in _CATEGORY_PATTERNS:
        if pattern.search(normalised):
            return category
    return "other"


def import_from_url(url: str, limit: int = 50, client: httpx.Client | None = None) -> list[ImportedProduct]:
    """Import up to `limit` products from a store or product page URL.

    Tries Shopify, then the WooCommerce Store API, then structured data on the
    page itself. Returns [] if nothing could be read; never raises on HTTP or
    parsing problems.
    """
    if limit <= 0:
        return []
    url = url.strip()
    if "://" not in url:
        url = f"https://{url}"
    parts = urlsplit(url)
    if not parts.netloc:
        return []
    origin = f"{parts.scheme}://{parts.netloc}"

    owns_client = client is None
    if client is None:
        client = httpx.Client(
            timeout=20, follow_redirects=True, headers={"User-Agent": "ProductTryOnImporter/0.1"}
        )
    try:
        strategies: list[Callable[[], list[ImportedProduct]]] = [
            lambda: _import_shopify(client, origin, parts.path, limit),
            lambda: _import_woocommerce(client, origin, limit),
            lambda: _import_generic(client, url, limit),
        ]
        for strategy in strategies:
            products = strategy()
            if products:
                return products
        return []
    finally:
        if owns_client:
            client.close()


# --- shared helpers -------------------------------------------------------


def _fetch(client: httpx.Client, url: str) -> httpx.Response | None:
    """GET a URL, returning None on transport errors or non-200 status."""
    try:
        response = client.get(url)
    except httpx.HTTPError as exc:
        logger.debug("GET %s failed: %s", url, exc)
        return None
    if response.status_code != 200:
        logger.debug("GET %s returned %s", url, response.status_code)
        return None
    return response


def _fetch_json(client: httpx.Client, url: str) -> Any | None:
    response = _fetch(client, url)
    if response is None:
        return None
    try:
        return response.json()
    except ValueError:
        logger.debug("GET %s did not return JSON", url)
        return None


def _html_to_text(html: Any) -> str | None:
    """Strip tags, collapse whitespace and truncate; None when nothing is left."""
    if not isinstance(html, str) or not html.strip():
        return None
    text = BeautifulSoup(html, "html.parser").get_text(" ")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_DESCRIPTION] or None


def _clean_images(urls: Iterable[Any], base: str) -> list[str]:
    """Resolve to absolute http(s) URLs, dedupe in order and cap the count."""
    seen: dict[str, None] = {}
    for raw in urls:
        if not isinstance(raw, str) or not raw.strip():
            continue
        raw = raw.strip()
        absolute = f"https:{raw}" if raw.startswith("//") else urljoin(base, raw)
        if urlsplit(absolute).scheme in ("http", "https"):
            seen.setdefault(absolute)
    return list(seen)[:MAX_IMAGES]


def _text(value: Any) -> str | None:
    """Coerce a scalar to a stripped string, or None."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (str, int, float)):
        return str(value).strip() or None
    return None


def _collect(
    pages: Iterator[list[Any]], to_product: Callable[[dict[str, Any]], ImportedProduct | None], limit: int
) -> list[ImportedProduct]:
    """Convert items from successive pages, skipping unusable ones, until `limit`."""
    products: list[ImportedProduct] = []
    for items in pages:
        for item in items:
            product = to_product(item) if isinstance(item, dict) else None
            if product and product.image_urls:
                products.append(product)
                if len(products) >= limit:
                    return products
    return products


def _pages(client: httpx.Client, page_url: Callable[[int], str], key: str | None) -> Iterator[list[Any]]:
    """Yield item lists page by page until an empty or invalid response."""
    last_page: list[Any] | None = None
    for page in range(1, MAX_PAGES + 1):
        data = _fetch_json(client, page_url(page))
        items = data.get(key) if key and isinstance(data, dict) else data
        if not isinstance(items, list) or not items or items == last_page:
            return
        last_page = items
        yield items


# --- Shopify --------------------------------------------------------------


def _import_shopify(client: httpx.Client, origin: str, path: str, limit: int) -> list[ImportedProduct]:
    collection = re.fullmatch(r"/collections/([^/]+)/?", path)
    base = f"{origin}/collections/{collection.group(1)}" if collection else origin

    def page_url(page: int) -> str:
        return f"{base}/products.json?limit=250&page={page}"

    def to_product(item: dict[str, Any]) -> ImportedProduct | None:
        title = _text(item.get("title"))
        if not title:
            return None
        tags = item.get("tags") or []
        if isinstance(tags, str):
            tags = tags.split(",")
        product_type = _text(item.get("product_type")) or ""
        category_text = " ".join([title, product_type, *(t for t in tags if isinstance(t, str))])

        variants = item.get("variants")
        first_variant = variants[0] if isinstance(variants, list) and variants else None
        price = _text(first_variant.get("price")) if isinstance(first_variant, dict) else None

        images = item.get("images")
        sources = [img.get("src") for img in images if isinstance(img, dict)] if isinstance(images, list) else []
        handle = _text(item.get("handle"))
        return ImportedProduct(
            name=title,
            category=infer_category(category_text),
            image_urls=_clean_images(sources, origin),
            description=_html_to_text(item.get("body_html")),
            price=price,
            product_url=f"{origin}/products/{handle}" if handle else None,
            platform="shopify",
        )

    return _collect(_pages(client, page_url, "products"), to_product, limit)


# --- WooCommerce ----------------------------------------------------------


def _woo_price(prices: Any) -> tuple[str | None, str | None]:
    """Convert Store API minor-unit prices ("125000", 2) to ("1250.00", code)."""
    if not isinstance(prices, dict):
        return None, None
    currency = _text(prices.get("currency_code"))
    raw = _text(prices.get("price"))
    if raw is None:
        return None, currency
    minor = prices.get("currency_minor_unit")
    minor = minor if isinstance(minor, int) and not isinstance(minor, bool) and minor >= 0 else 2
    try:
        return f"{Decimal(raw).scaleb(-minor):.{minor}f}", currency
    except InvalidOperation:
        return None, currency


def _import_woocommerce(client: httpx.Client, origin: str, limit: int) -> list[ImportedProduct]:
    def page_url(page: int) -> str:
        return f"{origin}/wp-json/wc/store/v1/products?per_page=100&page={page}"

    def to_product(item: dict[str, Any]) -> ImportedProduct | None:
        name = _text(item.get("name"))
        if not name:
            return None
        categories = item.get("categories")
        category_names = [c.get("name") for c in categories if isinstance(c, dict)] if isinstance(categories, list) else []
        images = item.get("images")
        sources = [img.get("src") for img in images if isinstance(img, dict)] if isinstance(images, list) else []
        price, currency = _woo_price(item.get("prices"))
        permalink = _text(item.get("permalink"))
        return ImportedProduct(
            name=name,
            category=infer_category(" ".join([name, *(n for n in category_names if isinstance(n, str))])),
            image_urls=_clean_images(sources, origin),
            description=_html_to_text(item.get("description")),
            price=price,
            currency=currency,
            product_url=permalink,
            platform="woocommerce",
        )

    return _collect(_pages(client, page_url, None), to_product, limit)


# --- generic product page -------------------------------------------------


def _is_product(node: dict[str, Any]) -> bool:
    node_type = node.get("@type")
    return node_type == "Product" or (isinstance(node_type, list) and "Product" in node_type)


def _find_products(node: Any) -> Iterator[dict[str, Any]]:
    """Walk parsed JSON-LD (lists, dicts, @graph) yielding Product objects."""
    if isinstance(node, list):
        for child in node:
            yield from _find_products(child)
    elif isinstance(node, dict):
        if _is_product(node):
            yield node
        else:
            for child in node.values():
                if isinstance(child, (list, dict)):
                    yield from _find_products(child)


def _image_sources(image: Any) -> list[Any]:
    """Flatten a JSON-LD `image` (string, ImageObject or a list of either) to URLs."""
    if isinstance(image, str):
        return [image]
    if isinstance(image, dict):
        return [image.get("url") or image.get("contentUrl")]
    if isinstance(image, list):
        return [src for child in image for src in _image_sources(child)]
    return []


def _offer_price(offers: Any) -> tuple[str | None, str | None]:
    """First price and currency found in an Offer, AggregateOffer or list of them."""
    candidates = offers if isinstance(offers, list) else [offers]
    for offer in candidates:
        if not isinstance(offer, dict):
            continue
        price = _text(offer.get("price")) or _text(offer.get("lowPrice"))
        if price is not None:
            return price, _text(offer.get("priceCurrency"))
    return None, None


def _category_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return _category_text(value.get("name"))
    if isinstance(value, list):
        return " ".join(_category_text(v) for v in value)
    return ""


def _parse_json_ld(soup: BeautifulSoup) -> Iterator[Any]:
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            yield json.loads(script.string or script.get_text(), strict=False)
        except ValueError:
            logger.debug("Skipping invalid JSON-LD block")


def _meta_content(soup: BeautifulSoup, prop: str) -> list[str]:
    tags = soup.find_all("meta", attrs={"property": prop})
    return [t["content"].strip() for t in tags if isinstance(t.get("content"), str) and t["content"].strip()]


def _import_generic(client: httpx.Client, url: str, limit: int) -> list[ImportedProduct]:
    response = _fetch(client, url)
    if response is None:
        return []
    soup = BeautifulSoup(response.text, "html.parser")
    page_url = str(response.url) if response.url else url
    page_title = soup.title.get_text(" ", strip=True) if soup.title else ""

    products: list[ImportedProduct] = []
    for block in _parse_json_ld(soup):
        for node in _find_products(block):
            name = _text(node.get("name"))
            images = _clean_images(_image_sources(node.get("image")), page_url)
            if not name or not images:
                continue
            price, currency = _offer_price(node.get("offers"))
            products.append(
                ImportedProduct(
                    name=name,
                    category=infer_category(f"{name} {_category_text(node.get('category'))} {page_title}"),
                    image_urls=images,
                    description=_html_to_text(node.get("description")),
                    price=price,
                    currency=currency,
                    product_url=urljoin(page_url, _text(node.get("url")) or page_url),
                    platform="generic",
                )
            )
            if len(products) >= limit:
                return products
    if products:
        return products

    # No usable structured data: fall back to Open Graph tags.
    og_images = _clean_images(_meta_content(soup, "og:image"), page_url)
    if not og_images:
        return []
    og_title = next(iter(_meta_content(soup, "og:title")), None) or page_title
    og_description = next(iter(_meta_content(soup, "og:description")), None)
    return [
        ImportedProduct(
            name=og_title or page_url,
            category=infer_category(f"{og_title} {page_title}"),
            image_urls=og_images,
            description=_html_to_text(og_description),
            product_url=page_url,
            platform="generic",
        )
    ]
