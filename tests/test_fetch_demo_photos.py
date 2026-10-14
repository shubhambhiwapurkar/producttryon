import csv
import io
import itertools

import httpx
import pytest
from PIL import Image

from app import config
from scripts.fetch_demo_photos import PRICE_RANGES, PRODUCT_QUERIES, main


def jpeg_bytes(color=(200, 150, 90)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (120, 160), color).save(buf, "JPEG")
    return buf.getvalue()


JPEG = jpeg_bytes()
N_PRODUCT_QUERIES = sum(len(queries) for queries in PRODUCT_QUERIES.values())


@pytest.fixture(autouse=True)
def no_pexels_key(monkeypatch):
    monkeypatch.delenv("PEXELS_API_KEY", raising=False)


def image_response(request: httpx.Request, broken: set[str] = frozenset()) -> httpx.Response:
    if str(request.url) in broken:
        return httpx.Response(503)
    return httpx.Response(200, content=JPEG, headers={"content-type": "image/jpeg"})


def openverse_handler(broken=frozenset(), failing_queries=frozenset(), log=None):
    """Fake Openverse: each query returns page_size unique photos; images are real JPEGs."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host != "api.openverse.org":
            return image_response(request, broken)
        params = request.url.params
        if log is not None:
            log.append(params)
        query = params["q"]
        if query in failing_queries:
            return httpx.Response(500)
        slug = query.replace(" ", "-")
        results = [
            {
                "id": f"{slug}-{i}",
                "title": f"{query} piece {i}",
                "url": f"https://images.example/{slug}-{i}.jpg",
                "creator": "Ada",
                "license": "by",
                "license_version": "4.0",
                "foreign_landing_url": f"https://example.org/{slug}-{i}",
            }
            for i in range(int(params["page_size"]))
        ]
        return httpx.Response(200, json={"results": results})

    return handler


def client_for(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def read_csv(out):
    with (out / "metadata.csv").open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def test_query_categories_are_known_and_priced():
    assert set(PRODUCT_QUERIES) <= set(config.CATEGORIES)
    assert set(PRICE_RANGES) == set(PRODUCT_QUERIES)


def test_openverse_writes_images_metadata_and_attribution(tmp_path, capsys):
    out = tmp_path / "photos"
    search_params = []
    client = client_for(openverse_handler(log=search_params))

    main([str(out), "--source", "openverse", "--per-query", "2", "--models", "0"], client=client)

    assert all(p["license_type"] == "commercial" and p["mature"] == "false" for p in search_params)
    assert len(search_params) == N_PRODUCT_QUERIES

    rows = read_csv(out)
    assert len(rows) == 2 * N_PRODUCT_QUERIES
    assert len(list(out.glob("necklace-*.jpg"))) == 6
    for path in out.glob("*.jpg"):
        assert Image.open(path).format == "JPEG"

    first = next(r for r in rows if r["file"] == "necklace-1.jpg")
    assert first["name"] == "Gold Necklace Jewelry Piece 0"
    assert first["category"] == "necklace"
    assert first["currency"] == "INR"
    assert first["description"] == (
        '"gold necklace jewelry piece 0" by Ada, licensed CC BY 4.0 '
        "(https://example.org/gold-necklace-jewelry-0)"
    )
    for row in rows:
        low, high = PRICE_RANGES[row["category"]]
        assert row["price"].isdigit() and low <= int(row["price"]) <= high and int(row["price"]) % 500 == 0

    last_line = capsys.readouterr().out.strip().splitlines()[-1]
    assert last_line == f'python -m scripts.seed_from_folder {out} --store demo --create "Demo Jewellers"'


def test_pexels_sends_key_and_downloads_large2x(tmp_path, monkeypatch):
    monkeypatch.setenv("PEXELS_API_KEY", "secret-key")
    out = tmp_path / "photos"
    ids = itertools.count(100)
    auth_seen = []
    image_paths = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.pexels.com":
            auth_seen.append(request.headers.get("Authorization"))
            photos = []
            for _ in range(int(request.url.params["per_page"])):
                pid = next(ids)
                photos.append({
                    "id": pid,
                    "alt": request.url.params["query"],
                    "photographer": "Ravi",
                    "url": f"https://www.pexels.com/photo/{pid}/",
                    "src": {
                        "large2x": f"https://images.example/large2x/{pid}.jpg",
                        "large": f"https://images.example/large/{pid}.jpg",
                        "medium": f"https://images.example/medium/{pid}.jpg",
                        "original": f"https://images.example/original/{pid}.jpg",
                    },
                })
            return httpx.Response(200, json={"photos": photos})
        image_paths.append(request.url.path)
        if not request.url.path.startswith("/large2x/"):
            return httpx.Response(404)
        return image_response(request)

    # No --source: the key in the environment selects pexels.
    main([str(out), "--per-query", "1", "--models", "0"], client=client_for(handler))

    assert auth_seen == ["secret-key"] * N_PRODUCT_QUERIES
    assert image_paths and all(path.startswith("/large2x/") for path in image_paths)
    assert len(list(out.glob("*.jpg"))) == N_PRODUCT_QUERIES
    rows = read_csv(out)
    first = next(r for r in rows if r["file"] == "necklace-1.jpg")
    assert first["name"] == "Gold Necklace Jewelry"
    assert first["description"] == '"gold necklace jewelry" by Ravi on Pexels (https://www.pexels.com/photo/100/)'


def test_pexels_source_without_key_is_rejected(tmp_path):
    with pytest.raises(SystemExit) as exc:
        main([str(tmp_path / "photos"), "--source", "pexels"], client=client_for(openverse_handler()))
    assert exc.value.code == 2


def test_failed_download_and_search_are_skipped(tmp_path, capsys):
    out = tmp_path / "photos"
    handler = openverse_handler(
        broken={"https://images.example/diamond-ring-0.jpg"},
        failing_queries={"gold bangles"},
    )

    main([str(out), "--source", "openverse", "--per-query", "1", "--models", "0"], client=client_for(handler))

    names = {p.name for p in out.glob("*.jpg")}
    assert "ring-1.jpg" in names  # from "gold ring jewelry"; "diamond ring" was broken
    assert "ring-2.jpg" not in names
    assert not any(name.startswith("bangle") for name in names)
    ring_rows = [r for r in read_csv(out) if r["category"] == "ring"]
    assert [r["file"] for r in ring_rows] == ["ring-1.jpg"]
    assert ring_rows[0]["name"] == "Gold Ring Jewelry Piece 0"
    err = capsys.readouterr().err
    assert "diamond-ring-0.jpg" in err
    assert "gold bangles" in err


def test_models_go_to_models_dir_not_csv(tmp_path, capsys):
    out = tmp_path / "photos"

    main(
        [str(out), "--source", "openverse", "--per-query", "1", "--models", "4"],
        client=client_for(openverse_handler()),
    )

    models = sorted((out / "_models").glob("*.jpg"))
    assert len(models) == 4
    rows = read_csv(out)
    assert len(rows) == N_PRODUCT_QUERIES
    assert not any(r["file"].startswith("model") for r in rows)
    assert len(list(out.glob("*.jpg"))) == N_PRODUCT_QUERIES  # models are not at the top level
    printed = capsys.readouterr().out
    for path in models:
        assert str(path) in printed


def test_refuses_folder_that_already_has_metadata(tmp_path):
    out = tmp_path / "photos"
    out.mkdir()
    (out / "metadata.csv").write_text("file,name\n", encoding="utf-8")

    with pytest.raises(SystemExit) as exc:
        main([str(out), "--source", "openverse"], client=client_for(openverse_handler()))
    assert exc.value.code == 1
