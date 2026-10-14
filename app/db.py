import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, ForeignKey, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

from . import config


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class Store(Base):
    """A client (jeweller) using the platform."""

    __tablename__ = "stores"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    whatsapp_number: Mapped[str | None] = mapped_column(String(32))
    website_url: Mapped[str | None] = mapped_column(String(500))
    admin_token: Mapped[str] = mapped_column(String(64), default=lambda: secrets.token_urlsafe(24))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    products: Mapped[list["Product"]] = relationship(back_populates="store", cascade="all, delete-orphan")


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(primary_key=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    name: Mapped[str] = mapped_column(String(300))
    category: Mapped[str] = mapped_column(String(32), index=True)
    description: Mapped[str | None] = mapped_column(Text)
    price: Mapped[str | None] = mapped_column(String(32))
    currency: Mapped[str | None] = mapped_column(String(8))
    dimensions: Mapped[str | None] = mapped_column(String(200))
    product_url: Mapped[str | None] = mapped_column(String(1000))
    # "manual" (uploaded in admin), "import" (pulled from the store's website), "dataset"
    source: Mapped[str] = mapped_column(String(16), default="manual")
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    store: Mapped[Store] = relationship(back_populates="products")
    images: Mapped[list["ProductImage"]] = relationship(
        back_populates="product", cascade="all, delete-orphan", order_by="ProductImage.position"
    )


class ProductImage(Base):
    __tablename__ = "product_images"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    path: Mapped[str] = mapped_column(String(500))  # relative to MEDIA_DIR
    angle: Mapped[str | None] = mapped_column(String(32))  # front, side, back, worn, ...
    position: Mapped[int] = mapped_column(default=0)

    product: Mapped[Product] = relationship(back_populates="images")


class TryOn(Base):
    """One customer try-on request. Either product_id is set, or the customer
    uploaded photos of their own piece (custom_image_paths)."""

    __tablename__ = "tryons"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"))
    category: Mapped[str] = mapped_column(String(32))
    selfie_path: Mapped[str | None] = mapped_column(String(500))
    custom_image_paths: Mapped[list | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued, running, done, failed
    result_path: Mapped[str | None] = mapped_column(String(500))
    renderer: Mapped[str | None] = mapped_column(String(32))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(default=utcnow, index=True)
    finished_at: Mapped[datetime | None] = mapped_column()


engine = None
SessionLocal = sessionmaker(expire_on_commit=False)


def init_db(url: str | None = None) -> None:
    global engine
    url = url or config.DATABASE_URL
    if url.startswith("sqlite:///"):
        from pathlib import Path

        Path(url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(url, connect_args={"check_same_thread": False} if url.startswith("sqlite") else {})
    SessionLocal.configure(bind=engine)
    Base.metadata.create_all(engine)


def get_session():
    with SessionLocal() as session:
        yield session
