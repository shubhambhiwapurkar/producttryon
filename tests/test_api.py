import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import config


def png(color=(200, 160, 60), size=(400, 500)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    monkeypatch.setattr(config, "DATABASE_URL", f"sqlite:///{tmp_path}/test.db")
    monkeypatch.setattr(config, "PLATFORM_ADMIN_KEY", "platform-key")
    monkeypatch.setattr(config, "RENDERER", "mock")
    from app.main import create_app

    with TestClient(create_app()) as c:
        yield c


@pytest.fixture
def store(client):
    resp = client.post(
        "/api/platform/stores",
        json={"slug": "demo", "name": "Demo Jewellers", "whatsapp_number": "+919876543210"},
        headers={"X-Platform-Key": "platform-key"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def admin(store):
    return {"X-Admin-Token": store["admin_token"]}


def add_product(client, store, name="Kundan Choker", category="necklace"):
    resp = client.post(
        "/api/stores/demo/products",
        headers=admin(store),
        data={"name": name, "category": category, "price": "45000", "currency": "INR", "angles": ["front", "side"]},
        files=[("images", ("a.png", png(), "image/png")), ("images", ("b.png", png((150, 120, 40)), "image/png"))],
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_store_creation_requires_platform_key(client):
    resp = client.post("/api/platform/stores", json={"slug": "x1", "name": "X"}, headers={"X-Platform-Key": "nope"})
    assert resp.status_code == 401


def test_admin_routes_require_token(client, store):
    assert client.get("/api/stores/demo/admin/check").status_code == 401
    assert client.get("/api/stores/demo/admin/check", headers={"X-Admin-Token": "wrong"}).status_code == 401
    assert client.get("/api/stores/demo/admin/check", headers=admin(store)).status_code == 200


def test_product_crud(client, store):
    product = add_product(client, store)
    assert [i["angle"] for i in product["images"]] == ["front", "side"]
    assert client.get(product["images"][0]["url"]).status_code == 200

    listed = client.get("/api/stores/demo/products", params={"category": "necklace"}).json()
    assert [p["id"] for p in listed] == [product["id"]]
    assert client.get("/api/stores/demo").json()["categories"] == {"necklace": 1}

    assert client.delete(f"/api/stores/demo/products/{product['id']}", headers=admin(store)).status_code == 204
    assert client.get("/api/stores/demo/products").json() == []


def test_rejects_non_image_upload(client, store):
    resp = client.post(
        "/api/stores/demo/products",
        headers=admin(store),
        data={"name": "Bad", "category": "ring"},
        files=[("images", ("a.txt", b"not an image", "text/plain"))],
    )
    assert resp.status_code == 400


def test_tryon_catalogue_product(client, store):
    product = add_product(client, store)
    resp = client.post(
        "/api/stores/demo/tryons",
        data={"product_id": product["id"], "consent": "true"},
        files={"selfie": ("me.png", png((220, 190, 170), (600, 800)), "image/png")},
    )
    assert resp.status_code == 202, resp.text
    job = client.get(f"/api/tryons/{resp.json()['id']}").json()
    assert job["status"] == "done", job
    assert job["renderer"] == "mock" and job["category"] == "necklace"
    assert client.get(job["result_url"]).status_code == 200


def test_tryon_customer_own_piece(client, store):
    resp = client.post(
        "/api/stores/demo/tryons",
        data={"category": "earrings", "consent": "true"},
        files=[
            ("selfie", ("me.png", png((220, 190, 170)), "image/png")),
            ("product_images", ("e.png", png(), "image/png")),
        ],
    )
    assert resp.status_code == 202, resp.text
    job = client.get(f"/api/tryons/{resp.json()['id']}").json()
    assert job["status"] == "done" and job["product_id"] is None


def test_tryon_requires_consent_and_a_product(client, store):
    selfie = {"selfie": ("me.png", png(), "image/png")}
    assert client.post("/api/stores/demo/tryons", data={"consent": "false", "category": "ring"}, files=selfie).status_code == 400
    assert client.post("/api/stores/demo/tryons", data={"consent": "true"}, files=selfie).status_code == 400


def test_tryon_cannot_use_another_stores_product(client, store):
    product = add_product(client, store)
    client.post("/api/platform/stores", json={"slug": "other", "name": "Other"}, headers={"X-Platform-Key": "platform-key"})
    resp = client.post(
        "/api/stores/other/tryons",
        data={"product_id": product["id"], "consent": "true"},
        files={"selfie": ("me.png", png(), "image/png")},
    )
    assert resp.status_code == 404


def test_import_blocks_private_addresses(client, store):
    resp = client.post("/api/stores/demo/import", headers=admin(store), json={"url": "http://127.0.0.1:8000/shop"})
    assert resp.status_code == 200
    assert resp.json()["imported"] == 0


@pytest.mark.parametrize("url", ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/x", "file:///etc/passwd"])
def test_safe_client_refuses_internal_urls(url):
    import httpx

    from app.netsafe import BlockedURL, safe_client

    with safe_client() as c, pytest.raises((BlockedURL, httpx.UnsupportedProtocol)):
        c.get(url)
