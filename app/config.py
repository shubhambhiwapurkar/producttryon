import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
MEDIA_DIR = DATA_DIR / "media"
DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DATA_DIR / 'tryon.db'}")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_IMAGE_MODEL = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-3-pro-image-preview")
# "gemini" (AI edit), "composite" (places the exact product photo using face landmarks;
# earrings, necklaces, pendants, maang tikka, nose pins) or "mock" (offline placeholder).
RENDERER = os.environ.get("TRYON_RENDERER") or ("gemini" if GEMINI_API_KEY else "composite")

PLATFORM_ADMIN_KEY = os.environ.get("PLATFORM_ADMIN_KEY", "")
# When true, anyone can create a store from the onboarding wizard (/onboard).
# Otherwise the wizard asks for an invite code (comma-separated list) or the platform key.
OPEN_SIGNUP = os.environ.get("OPEN_SIGNUP", "").lower() in ("1", "true", "yes")
INVITE_CODES = {c.strip() for c in os.environ.get("INVITE_CODES", "").split(",") if c.strip()}
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "7"))

MAX_UPLOAD_BYTES = 15 * 1024 * 1024
MAX_PRODUCT_IMAGES = 5
# Longest side, in pixels, of images sent to the renderer
RENDER_MAX_SIDE = 1536

CATEGORIES = [
    "necklace",
    "earrings",
    "ring",
    "bracelet",
    "bangle",
    "pendant",
    "nose_pin",
    "maang_tikka",
    "anklet",
    "other",
]
