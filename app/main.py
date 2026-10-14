"""HTTP API and page routes.

Pages
  /s/{slug}            customer try-on page for a store
  /admin/{slug}        store admin (products, website import, settings)
  /onboard             step-by-step setup wizard for a new store
API
  see the route definitions below; admin routes need the X-Admin-Token header.
"""

import io
import logging
import re
import secrets
import unicodedata
from pathlib import Path
from typing import Annotated

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import config, db
from .imaging import InvalidImage, delete_media, save_image
from .importers import import_from_url
from .netsafe import fetch_image, safe_client
from .tryon import purge_expired, run_tryon

log = logging.getLogger(__name__)
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
SessionDep = Annotated[Session, Depends(db.get_session)]


# ---------- helpers ----------


def media_url(path: str | None) -> str | None:
    return f"/media/{path}" if path else None


def product_out(p: db.Product) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "category": p.category,
        "description": p.description,
        "price": p.price,
        "currency": p.currency,
        "dimensions": p.dimensions,
        "product_url": p.product_url,
        "source": p.source,
        "images": [{"id": i.id, "url": media_url(i.path), "angle": i.angle} for i in p.images],
    }


def store_out(s: db.Store, session: Session) -> dict:
    counts = session.execute(
        select(db.Product.category, func.count()).where(db.Product.store_id == s.id).group_by(db.Product.category)
    ).all()
    return {
        "slug": s.slug,
        "name": s.name,
        "whatsapp_number": s.whatsapp_number,
        "website_url": s.website_url,
        "categories": {cat: n for cat, n in counts},
        "all_categories": config.CATEGORIES,
    }


def get_store(slug: str, session: Session) -> db.Store:
    store = session.scalar(select(db.Store).where(db.Store.slug == slug))
    if store is None:
        raise HTTPException(404, "Store not found")
    return store


def require_admin(slug: str, session: SessionDep, x_admin_token: Annotated[str, Header()] = "") -> db.Store:
    store = get_store(slug, session)
    if not x_admin_token or not secrets.compare_digest(x_admin_token, store.admin_token):
        raise HTTPException(401, "Invalid admin token")
    return store


AdminStore = Annotated[db.Store, Depends(require_admin)]


async def read_upload(upload: UploadFile) -> bytes:
    data = await upload.read(config.MAX_UPLOAD_BYTES + 1)
    if len(data) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"{upload.filename} is larger than 15 MB")
    return data


def store_image(data: bytes, folder: str) -> str:
    try:
        return save_image(data, folder)
    except InvalidImage:
        raise HTTPException(400, "One of the files is not a readable image")


def check_category(category: str) -> str:
    if category not in config.CATEGORIES:
        raise HTTPException(400, f"category must be one of {config.CATEGORIES}")
    return category


# ---------- request bodies ----------


def slugify(name: str) -> str:
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:50] or "store"


def unique_slug(base: str, session: Session) -> str:
    slug, n = base, 2
    while session.scalar(select(db.Store.id).where(db.Store.slug == slug)) is not None:
        slug, n = f"{base}-{n}", n + 1
    return slug


class Signup(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    slug: str | None = Field(default=None, pattern=r"^[a-z0-9][a-z0-9-]{1,62}$")
    whatsapp_number: str | None = None
    website_url: str | None = None
    invite_code: str | None = None


class ProductUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=300)
    category: str | None = None
    description: str | None = None
    price: str | None = None
    currency: str | None = None
    dimensions: str | None = None
    product_url: str | None = None


class StoreCreate(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,62}$")
    name: str = Field(min_length=1, max_length=200)
    whatsapp_number: str | None = None
    website_url: str | None = None


class StoreUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    whatsapp_number: str | None = None
    website_url: str | None = None


class ImportRequest(BaseModel):
    url: str = Field(min_length=4, max_length=1000)
    limit: int = Field(default=20, ge=1, le=200)


# ---------- app ----------


def create_app() -> FastAPI:
    db.init_db()
    config.MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    app = FastAPI(title="Product Try-On")
    app.mount("/media", StaticFiles(directory=config.MEDIA_DIR), name="media")
    app.mount("/static", StaticFiles(directory=WEB_DIR, check_dir=False), name="static")

    # ----- pages -----

    @app.get("/", include_in_schema=False)
    def home():
        return RedirectResponse("/s/demo")

    @app.get("/s/{slug}", include_in_schema=False)
    def shop_page(slug: str):
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/admin/{slug}", include_in_schema=False)
    def admin_page(slug: str):
        return FileResponse(WEB_DIR / "admin.html")

    @app.get("/onboard", include_in_schema=False)
    def onboard_page():
        return FileResponse(WEB_DIR / "onboard.html")

    # ----- onboarding -----

    @app.get("/api/signup/config")
    def signup_config():
        return {"open_signup": config.OPEN_SIGNUP, "categories": config.CATEGORIES}

    @app.post("/api/signup", status_code=201)
    def signup(body: Signup, session: SessionDep):
        """Create a store from the onboarding wizard. Returns the admin token once."""
        if not config.OPEN_SIGNUP:
            code = body.invite_code or ""
            platform_ok = bool(config.PLATFORM_ADMIN_KEY) and secrets.compare_digest(code, config.PLATFORM_ADMIN_KEY)
            if not (platform_ok or code in config.INVITE_CODES):
                raise HTTPException(403, "A valid invite code is required")
        if body.slug and session.scalar(select(db.Store.id).where(db.Store.slug == body.slug)) is not None:
            raise HTTPException(409, "That store link is already taken")
        store = db.Store(
            slug=body.slug or unique_slug(slugify(body.name), session),
            name=body.name,
            whatsapp_number=body.whatsapp_number,
            website_url=body.website_url,
        )
        session.add(store)
        session.commit()
        return {**store_out(store, session), "admin_token": store.admin_token}

    @app.get("/api/stores/{slug}/qr.png", include_in_schema=False)
    def store_qr(slug: str, request: Request, session: SessionDep):
        """QR code of the customer page, for the shop counter and social posts."""
        import qrcode

        store = get_store(slug, session)
        img = qrcode.make(str(request.base_url).rstrip("/") + f"/s/{store.slug}", box_size=10, border=2)
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return Response(buf.getvalue(), media_type="image/png")

    # ----- platform -----

    @app.post("/api/platform/stores", status_code=201)
    def create_store(body: StoreCreate, session: SessionDep, x_platform_key: Annotated[str, Header()] = ""):
        if not config.PLATFORM_ADMIN_KEY or not secrets.compare_digest(x_platform_key, config.PLATFORM_ADMIN_KEY):
            raise HTTPException(401, "Invalid platform key")
        if session.scalar(select(db.Store).where(db.Store.slug == body.slug)):
            raise HTTPException(409, "Slug already taken")
        store = db.Store(**body.model_dump())
        session.add(store)
        session.commit()
        return {**store_out(store, session), "admin_token": store.admin_token}

    # ----- store (public) -----

    @app.get("/api/stores/{slug}")
    def read_store(slug: str, session: SessionDep):
        return store_out(get_store(slug, session), session)

    @app.get("/api/stores/{slug}/products")
    def list_products(slug: str, session: SessionDep, category: str | None = None, q: str | None = None):
        store = get_store(slug, session)
        stmt = select(db.Product).where(db.Product.store_id == store.id).order_by(db.Product.id.desc())
        if category:
            stmt = stmt.where(db.Product.category == category)
        if q:
            stmt = stmt.where(db.Product.name.ilike(f"%{q}%"))
        return [product_out(p) for p in session.scalars(stmt)]

    @app.get("/api/stores/{slug}/products/{product_id}")
    def read_product(slug: str, product_id: int, session: SessionDep):
        store = get_store(slug, session)
        product = session.get(db.Product, product_id)
        if product is None or product.store_id != store.id:
            raise HTTPException(404, "Product not found")
        return product_out(product)

    # ----- store (admin) -----

    @app.get("/api/stores/{slug}/admin/check")
    def admin_check(store: AdminStore, session: SessionDep):
        return store_out(store, session)

    @app.patch("/api/stores/{slug}")
    def update_store(body: StoreUpdate, store: AdminStore, session: SessionDep):
        for key, value in body.model_dump(exclude_unset=True).items():
            setattr(store, key, value.strip() or None if isinstance(value, str) and key != "name" else value)
        session.commit()
        return store_out(store, session)

    @app.post("/api/stores/{slug}/products", status_code=201)
    async def create_product(
        store: AdminStore,
        session: SessionDep,
        name: Annotated[str, Form(min_length=1, max_length=300)],
        category: Annotated[str, Form()],
        images: Annotated[list[UploadFile], File()],
        angles: Annotated[list[str] | None, Form()] = None,
        description: Annotated[str | None, Form()] = None,
        price: Annotated[str | None, Form()] = None,
        currency: Annotated[str | None, Form()] = None,
        dimensions: Annotated[str | None, Form()] = None,
        product_url: Annotated[str | None, Form()] = None,
    ):
        check_category(category)
        if not 1 <= len(images) <= config.MAX_PRODUCT_IMAGES:
            raise HTTPException(400, f"Upload 1 to {config.MAX_PRODUCT_IMAGES} product photos")
        product = db.Product(
            store_id=store.id, name=name, category=category, description=description, price=price,
            currency=currency, dimensions=dimensions, product_url=product_url, source="manual",
        )
        angles = angles or []
        for pos, upload in enumerate(images):
            path = store_image(await read_upload(upload), f"products/{store.slug}")
            angle = angles[pos] if pos < len(angles) and angles[pos] else None
            product.images.append(db.ProductImage(path=path, angle=angle, position=pos))
        session.add(product)
        session.commit()
        return product_out(product)

    @app.patch("/api/stores/{slug}/products/{product_id}")
    def update_product(product_id: int, body: ProductUpdate, store: AdminStore, session: SessionDep):
        product = session.get(db.Product, product_id)
        if product is None or product.store_id != store.id:
            raise HTTPException(404, "Product not found")
        changes = body.model_dump(exclude_unset=True)
        if "category" in changes:
            check_category(changes["category"])
        for key, value in changes.items():
            setattr(product, key, value)
        session.commit()
        return product_out(product)

    @app.delete("/api/stores/{slug}/products/{product_id}", status_code=204)
    def delete_product(product_id: int, store: AdminStore, session: SessionDep):
        product = session.get(db.Product, product_id)
        if product is None or product.store_id != store.id:
            raise HTTPException(404, "Product not found")
        for img in product.images:
            delete_media(img.path)
        session.delete(product)
        session.commit()

    @app.post("/api/stores/{slug}/import")
    def import_products(body: ImportRequest, store: AdminStore, session: SessionDep):
        """Pull products (details + photos) from the store's own website."""
        with safe_client() as client:
            found = import_from_url(body.url, limit=body.limit, client=client)
            existing = set(
                session.scalars(select(db.Product.product_url).where(db.Product.store_id == store.id))
            )
            imported, skipped, failed = 0, 0, 0
            for item in found:
                if item.product_url and item.product_url in existing:
                    skipped += 1
                    continue
                product = db.Product(
                    store_id=store.id, name=item.name[:300], category=item.category,
                    description=item.description, price=item.price, currency=item.currency,
                    product_url=item.product_url, source="import",
                )
                for url in item.image_urls[: config.MAX_PRODUCT_IMAGES]:
                    try:
                        path = save_image(fetch_image(client, url, config.MAX_UPLOAD_BYTES), f"products/{store.slug}")
                    except Exception as exc:
                        log.info("skipping image %s: %s", url, exc)
                        continue
                    product.images.append(db.ProductImage(path=path, position=len(product.images)))
                if not product.images:
                    failed += 1
                    continue
                session.add(product)
                session.commit()
                imported += 1
        if not store.website_url:
            store.website_url = body.url
            session.commit()
        return {"found": len(found), "imported": imported, "skipped_existing": skipped, "failed": failed}

    # ----- try-ons (customer) -----

    @app.post("/api/stores/{slug}/tryons", status_code=202)
    async def create_tryon(
        slug: str,
        session: SessionDep,
        background: BackgroundTasks,
        selfie: Annotated[UploadFile, File()],
        consent: Annotated[bool, Form()],
        product_id: Annotated[int | None, Form()] = None,
        category: Annotated[str | None, Form()] = None,
        product_images: Annotated[list[UploadFile] | None, File()] = None,
    ):
        """Try on a catalogue product (product_id) or the customer's own piece
        (product_images + category)."""
        store = get_store(slug, session)
        if not consent:
            raise HTTPException(400, "Consent to process the photo is required")
        purge_expired(session)

        job = db.TryOn(store_id=store.id)
        if product_id is not None:
            product = session.get(db.Product, product_id)
            if product is None or product.store_id != store.id:
                raise HTTPException(404, "Product not found")
            job.product_id, job.category = product.id, product.category
        else:
            if not product_images or not category:
                raise HTTPException(400, "Choose a product, or upload photos of your piece and pick its type")
            if len(product_images) > config.MAX_PRODUCT_IMAGES:
                raise HTTPException(400, f"Upload at most {config.MAX_PRODUCT_IMAGES} product photos")
            job.category = check_category(category)

        session.add(job)
        session.flush()  # assigns job.id
        folder = f"tryons/{job.id}"
        job.selfie_path = store_image(await read_upload(selfie), folder)
        if job.product_id is None:
            job.custom_image_paths = [store_image(await read_upload(f), folder) for f in product_images]
        session.commit()
        background.add_task(run_tryon, job.id)
        return {"id": job.id, "status": job.status}

    @app.get("/api/tryons/{tryon_id}")
    def read_tryon(tryon_id: str, session: SessionDep):
        if not re.fullmatch(r"[0-9a-f-]{36}", tryon_id):
            raise HTTPException(404, "Not found")
        job = session.get(db.TryOn, tryon_id)
        if job is None:
            raise HTTPException(404, "Not found")
        return {
            "id": job.id,
            "status": job.status,
            "category": job.category,
            "product_id": job.product_id,
            "result_url": media_url(job.result_path),
            "selfie_url": media_url(job.selfie_path),
            "renderer": job.renderer,
            "error": "We couldn't create this preview. Please try another photo." if job.status == "failed" else None,
        }

    return app


app = create_app()
