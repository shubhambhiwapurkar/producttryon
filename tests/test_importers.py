import json

import httpx
import pytest

from app.config import CATEGORIES
from app.importers import ImportedProduct, import_from_url, infer_category


def make_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)


def html_response(body: str) -> httpx.Response:
    return httpx.Response(200, text=body, headers={"content-type": "text/html"})


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Gold Plated Earrings", "earrings"),
        ("Pearl Studs", "earrings"),
        ("Gold Jhumka", "earrings"),
        ("Diamond Solitaire Ring", "ring"),
        ("Silver rings", "ring"),
        ("Nose Ring", "nose_pin"),
        ("Diamond Nose Stud", "nose_pin"),
        ("Kundan Choker Necklace", "necklace"),
        ("Pendant with chain", "pendant"),
        ("Silver Payal", "anklet"),
        ("Gift card", "other"),
        ("String bracelet", "bracelet"),
        ("Spring collection scarf", "other"),
        ("Polki Maang Tikka", "maang_tikka"),
        ("Gold Kada", "bangle"),
        ("Ear Cuff", "earrings"),
        ("", "other"),
    ],
)
def test_infer_category(text, expected):
    assert infer_category(text) == expected
    assert expected in CATEGORIES


def shopify_product(i: int, **overrides) -> dict:
    product = {
        "title": f"Product {i}",
        "body_html": "<p>Nice <b>piece</b></p>\n<p>of   jewellery</p>",
        "product_type": "Ring",
        "tags": "gold, festive",
        "handle": f"product-{i}",
        "variants": [{"price": "1999.00"}],
        "images": [{"src": f"//cdn.example.com/p{i}.jpg"}],
    }
    product.update(overrides)
    return product


def test_shopify_pagination_limit_and_images():
    requested = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(request.url)
        assert request.url.path == "/products.json"
        page = int(request.url.params["page"])
        pages = {1: [shopify_product(i) for i in range(3)], 2: [shopify_product(i) for i in range(3, 5)]}
        return httpx.Response(200, json={"products": pages.get(page, [])})

    products = import_from_url("shop.example.com", limit=50, client=make_client(handler))
    assert [p.name for p in products] == [f"Product {i}" for i in range(5)]
    assert [u.params["page"] for u in requested] == ["1", "2", "3"]
    first = products[0]
    assert first.platform == "shopify"
    assert first.category == "ring"
    assert first.image_urls == ["https://cdn.example.com/p0.jpg"]
    assert first.description == "Nice piece of jewellery"
    assert first.price == "1999.00"
    assert first.currency is None
    assert first.product_url == "https://shop.example.com/products/product-0"

    requested.clear()
    limited = import_from_url("https://shop.example.com", limit=4, client=make_client(handler))
    assert len(limited) == 4
    assert len(requested) == 2  # stops once the limit is reached


def test_shopify_list_tags_truncation_and_image_cap():
    long_html = "<div>" + "word " * 500 + "</div>"
    images = [{"src": f"https://cdn.example.com/{i % 10}.jpg"} for i in range(30)]
    item = shopify_product(1, tags=["bridal", "Jhumka"], product_type="", body_html=long_html, images=images)

    def handler(request: httpx.Request) -> httpx.Response:
        products = [item] if request.url.params["page"] == "1" else []
        return httpx.Response(200, json={"products": products})

    [product] = import_from_url("https://shop.example.com", client=make_client(handler))
    assert product.category == "earrings"
    assert len(product.description) <= 1000
    assert product.image_urls == [f"https://cdn.example.com/{i}.jpg" for i in range(8)]


def test_shopify_collection_url():
    paths = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        products = [shopify_product(1)] if request.url.params["page"] == "1" else []
        return httpx.Response(200, json={"products": products})

    products = import_from_url("https://shop.example.com/collections/necklaces", client=make_client(handler))
    assert len(products) == 1
    assert set(paths) == {"/collections/necklaces/products.json"}
    assert products[0].product_url == "https://shop.example.com/products/product-1"


def test_products_without_images_are_skipped():
    items = [shopify_product(1, images=[]), shopify_product(2), shopify_product(3, images=[{"src": None}])]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"products": items if request.url.params["page"] == "1" else []})

    products = import_from_url("https://shop.example.com", client=make_client(handler))
    assert [p.name for p in products] == ["Product 2"]


def test_woocommerce_after_shopify_404():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/wp-json/wc/store/v1/products":
            page = int(request.url.params["page"])
            assert request.url.params["per_page"] == "100"
            items = [
                {
                    "name": "Temple Haar",
                    "description": "<p>Long <em>haar</em></p>",
                    "permalink": "https://woo.example.com/product/temple-haar/",
                    "images": [{"src": "https://woo.example.com/a.jpg"}, {"src": "https://woo.example.com/a.jpg"}],
                    "categories": [{"name": "Necklaces"}],
                    "prices": {"price": "125000", "currency_minor_unit": 2, "currency_code": "INR"},
                },
                {
                    "name": "Plain Band",
                    "description": "",
                    "permalink": "https://woo.example.com/product/band/",
                    "images": [{"src": "https://woo.example.com/b.jpg"}],
                    "categories": [],
                    "prices": {"price": "500", "currency_minor_unit": 0, "currency_code": "INR"},
                },
            ]
            return httpx.Response(200, json=items if page == 1 else [])
        return httpx.Response(404)

    products = import_from_url("woo.example.com", client=make_client(handler))
    assert seen[0] == "/products.json"
    assert [p.platform for p in products] == ["woocommerce", "woocommerce"]
    first, second = products
    assert first.price == "1250.00"
    assert first.currency == "INR"
    assert first.category == "necklace"
    assert first.description == "Long haar"
    assert first.image_urls == ["https://woo.example.com/a.jpg"]
    assert first.product_url == "https://woo.example.com/product/temple-haar/"
    assert second.price == "500"
    assert second.category == "ring"
    assert second.description is None


def ld_page(data, title="Bridal Jewellery | Example") -> str:
    return f'<html><head><title>{title}</title><script type="application/ld+json">{json.dumps(data)}</script></head><body></body></html>'


def test_generic_json_ld_graph_with_image_objects():
    page = ld_page(
        {
            "@context": "https://schema.org",
            "@graph": [
                {"@type": "WebSite", "name": "Example"},
                {
                    "@type": ["Product", "Thing"],
                    "name": "Kundan Jhumka",
                    "description": "<b>Handmade</b> pair",
                    "image": [
                        {"@type": "ImageObject", "url": "/img/1.jpg"},
                        {"@type": "ImageObject", "contentUrl": "https://other.example.com/2.jpg"},
                        "/img/1.jpg",
                    ],
                    "offers": [{"@type": "Offer", "price": 2499, "priceCurrency": "INR"}],
                    "url": "/products/kundan-jhumka",
                },
            ],
        }
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/products/kundan-jhumka":
            return html_response(page)
        return httpx.Response(404)

    [product] = import_from_url("https://site.example.com/products/kundan-jhumka", client=make_client(handler))
    assert product.platform == "generic"
    assert product.name == "Kundan Jhumka"
    assert product.category == "earrings"
    assert product.image_urls == ["https://site.example.com/img/1.jpg", "https://other.example.com/2.jpg"]
    assert product.price == "2499"
    assert product.currency == "INR"
    assert product.description == "Handmade pair"
    assert product.product_url == "https://site.example.com/products/kundan-jhumka"


def test_generic_json_ld_skips_invalid_blocks_and_uses_page_url():
    good = {"@type": "Product", "name": "Gold Bangle", "image": "pic.jpg", "offers": {"price": "10", "priceCurrency": "USD"}}
    page = (
        "<html><head><title>Shop</title>"
        '<script type="application/ld+json">{not json</script>'
        f'<script type="application/ld+json">{json.dumps(good)}</script>'
        "</head></html>"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return html_response(page) if request.url.path == "/item/1" else httpx.Response(404)

    [product] = import_from_url("https://site.example.com/item/1", client=make_client(handler))
    assert product.category == "bangle"
    assert product.image_urls == ["https://site.example.com/item/pic.jpg"]
    assert product.product_url == "https://site.example.com/item/1"
    assert product.price == "10"


def test_generic_open_graph_fallback():
    page = """<html><head><title>Rose Gold Pendant - Example</title>
    <meta property="og:title" content="Rose Gold Pendant">
    <meta property="og:image" content="https://site.example.com/og1.jpg">
    <meta property="og:image" content="/og2.jpg">
    <meta property="og:description" content="A lovely pendant">
    </head></html>"""

    def handler(request: httpx.Request) -> httpx.Response:
        return html_response(page) if request.url.path == "/p" else httpx.Response(404)

    [product] = import_from_url("https://site.example.com/p", client=make_client(handler))
    assert product.name == "Rose Gold Pendant"
    assert product.category == "pendant"
    assert product.image_urls == ["https://site.example.com/og1.jpg", "https://site.example.com/og2.jpg"]
    assert product.description == "A lovely pendant"
    assert product.platform == "generic"


def test_generic_open_graph_without_image_returns_nothing():
    page = '<html><head><meta property="og:title" content="Something"></head></html>'

    def handler(request: httpx.Request) -> httpx.Response:
        return html_response(page) if request.url.path == "/p" else httpx.Response(404)

    assert import_from_url("https://site.example.com/p", client=make_client(handler)) == []


def test_everything_fails_returns_empty_list():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    assert import_from_url("https://down.example.com", client=make_client(handler)) == []


def test_transport_errors_and_non_json_do_not_raise():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/products.json":
            raise httpx.ConnectError("boom")
        if request.url.path.startswith("/wp-json"):
            return httpx.Response(200, text="<html>not json</html>")
        return httpx.Response(200, json={"unexpected": "shape"}, headers={"content-type": "application/json"})

    assert import_from_url("https://weird.example.com", client=make_client(handler)) == []


def test_given_client_is_not_closed_and_owned_client_is():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    client = make_client(handler)
    import_from_url("https://x.example.com", client=client)
    assert not client.is_closed
    client.close()


def test_imported_product_defaults():
    product = ImportedProduct(name="x", category="other")
    assert product.image_urls == [] and product.platform == "generic"
