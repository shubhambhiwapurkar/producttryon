"""Create a "demo" store filled with drawn sample jewellery, for trying the app
before any client catalogue exists. Also writes a sample selfie to data/demo-selfie.png.

Usage: python -m scripts.demo
"""

import io
import math

from PIL import Image, ImageDraw, ImageFilter
from sqlalchemy import select

from app import config, db, imaging

GOLD, DARK_GOLD = (212, 170, 80), (160, 120, 40)
RUBY, EMERALD, DIAMOND, PEARL = (200, 30, 60), (20, 140, 90), (220, 235, 250), (245, 245, 240)


def canvas() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (800, 800), (250, 248, 244))
    return img, ImageDraw.Draw(img)


def stone(d: ImageDraw.ImageDraw, x: float, y: float, r: float, color) -> None:
    d.ellipse([x - r - 3, y - r - 3, x + r + 3, y + r + 3], fill=GOLD, outline=DARK_GOLD, width=2)
    d.ellipse([x - r, y - r, x + r, y + r], fill=color)
    d.ellipse([x - r / 2, y - r / 1.6, x - r / 6, y - r / 4], fill=(255, 255, 255))


def necklace(color, pendant: bool = True, n: int = 17) -> Image.Image:
    img, d = canvas()
    for i in range(n):
        t = math.pi * (0.1 + 0.8 * i / (n - 1))
        stone(d, 400 - 300 * math.cos(t), 150 + 330 * math.sin(t), 16, color)
    if pendant:
        d.polygon([(400, 480), (450, 560), (400, 660), (350, 560)], fill=GOLD, outline=DARK_GOLD)
        stone(d, 400, 565, 30, color)
    return img


def jhumka(color) -> Image.Image:
    img, d = canvas()
    for cx in (250, 550):
        stone(d, cx, 200, 30, color)
        d.line([cx, 235, cx, 300], fill=DARK_GOLD, width=6)
        d.pieslice([cx - 110, 260, cx + 110, 520], 180, 360, fill=GOLD, outline=DARK_GOLD, width=3)
        for k in range(9):
            x = cx - 100 + k * 25
            d.ellipse([x - 8, 385, x + 8, 401], fill=color)
            d.line([x, 401, x, 430], fill=DARK_GOLD, width=2)
            d.ellipse([x - 6, 428, x + 6, 440], fill=GOLD)
    return img


def ring(color) -> Image.Image:
    img, d = canvas()
    d.ellipse([220, 300, 580, 660], outline=GOLD, width=40)
    d.ellipse([235, 315, 565, 645], outline=DARK_GOLD, width=4)
    stone(d, 400, 290, 70, color)
    return img


def selfie() -> Image.Image:
    img = Image.new("RGB", (900, 1200), (205, 215, 225))
    d = ImageDraw.Draw(img)
    skin, top = (224, 180, 150), (120, 40, 70)
    d.ellipse([230, 80, 670, 640], fill=(45, 30, 25))
    d.rounded_rectangle([0, 900, 900, 1200], 160, fill=top)
    d.polygon([(330, 900), (570, 900), (520, 650), (380, 650)], fill=skin)
    d.ellipse([140, 860, 760, 1060], fill=skin)
    d.rectangle([0, 1000, 900, 1200], fill=top)
    d.ellipse([290, 160, 610, 600], fill=skin)
    d.ellipse([270, 360, 310, 440], fill=skin)
    d.ellipse([590, 360, 630, 440], fill=skin)
    for ex in (385, 515):
        d.ellipse([ex - 28, 340, ex + 28, 372], fill=(255, 255, 255))
        d.ellipse([ex - 12, 344, ex + 12, 368], fill=(60, 40, 30))
    d.arc([400, 470, 500, 530], 20, 160, fill=(170, 80, 80), width=6)
    return img.filter(ImageFilter.GaussianBlur(1))


# name, category, price, dimensions, description, image
PRODUCTS = [
    ("Kundan Bridal Necklace", "necklace", "185000", "Length 16 in", "Handcrafted kundan necklace with ruby drops in 22K gold.", lambda: necklace(RUBY)),
    ("Emerald Pendant Set", "pendant", "92000", "Pendant 4 cm, chain 18 in", "Emerald-studded pendant on a fine gold chain.", lambda: necklace(EMERALD)),
    ("Pearl Choker", "necklace", "48000", "Length 14 in", "Classic freshwater pearl choker.", lambda: necklace(PEARL, pendant=False, n=23)),
    ("Temple Jhumka", "earrings", "36500", "Drop 5 cm", "Temple-style gold jhumkas with ruby accents.", lambda: jhumka(RUBY)),
    ("Emerald Jhumki", "earrings", "41000", "Drop 4.5 cm", "Emerald jhumkis with gold bead fringe.", lambda: jhumka(EMERALD)),
    ("Solitaire Ring", "ring", "125000", "Size 12, 0.5 ct", "Classic diamond solitaire in 18K gold.", lambda: ring(DIAMOND)),
    ("Ruby Cocktail Ring", "ring", "67000", "Size 14", "Bold ruby cocktail ring.", lambda: ring(RUBY)),
]


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def main() -> None:
    db.init_db()
    with db.SessionLocal() as session:
        store = session.scalar(select(db.Store).where(db.Store.slug == "demo"))
        if store is None:
            store = db.Store(slug="demo", name="Shree Demo Jewellers", whatsapp_number="+91 98765 43210")
            session.add(store)
            session.flush()
            for name, category, price, dims, desc, draw in PRODUCTS:
                path = imaging.save_image(png_bytes(draw()), "products/demo")
                session.add(db.Product(
                    store_id=store.id, name=name, category=category, price=price, currency="INR",
                    dimensions=dims, description=desc, source="dataset",
                    images=[db.ProductImage(path=path, angle="front", position=0)],
                ))
            session.commit()
            print(f"Created demo store with {len(PRODUCTS)} products.")
        else:
            print("Demo store already exists.")

    selfie_path = config.DATA_DIR / "demo-selfie.png"
    selfie().save(selfie_path)
    print("Customer page:  http://localhost:8000/s/demo")
    print("Admin page:     http://localhost:8000/admin/demo")
    print(f"Admin token:    {store.admin_token}")
    print(f"Sample selfie:  {selfie_path}")


if __name__ == "__main__":
    main()
