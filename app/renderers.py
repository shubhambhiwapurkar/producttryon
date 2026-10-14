"""Turn (customer photo + product photos) into a photo of the customer wearing the piece.

Renderers share one interface so the model can be swapped per category later
(e.g. a landmark-guided compositor for necklaces, a clothing try-on API for apparel).
"""

from dataclasses import dataclass
from typing import Protocol

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from . import config


@dataclass
class RenderRequest:
    category: str
    person: Image.Image
    product_images: list[Image.Image]
    product_name: str | None = None
    product_details: str | None = None  # description / dimensions, used as a size hint


class RenderError(RuntimeError):
    pass


class Renderer(Protocol):
    name: str

    def render(self, req: RenderRequest) -> Image.Image: ...


# Where and how each category is worn. Kept short and concrete: the model follows
# placement and scale instructions better than adjectives.
PLACEMENT = {
    "necklace": "around the person's neck, resting naturally on the collarbones and chest, following the curve of the neck",
    "pendant": "on a chain around the person's neck, the pendant resting centred on the upper chest",
    "earrings": "on both earlobes (a matching pair, one per ear; if only one ear is visible, show it on that ear), hanging naturally with gravity",
    "ring": "on the person's ring finger, sized to the finger and following its angle",
    "bracelet": "around the person's wrist, sitting loosely with natural drape",
    "bangle": "around the person's wrist, sitting loosely",
    "nose_pin": "on the side of the person's nostril, small and to scale",
    "maang_tikka": "on the person's forehead at the hair parting, with the chain running back along the parting",
    "anklet": "around the person's ankle",
    "other": "where this kind of jewellery is normally worn",
}


def build_prompt(req: RenderRequest) -> str:
    n = len(req.product_images)
    refs = "Image 2 is" if n == 1 else f"Images 2 to {n + 1} are"
    name = f' ("{req.product_name}")' if req.product_name else ""
    details = f"\nProduct details for scale: {req.product_details.strip()[:400]}" if req.product_details else ""
    return f"""Virtual jewellery try-on.
Image 1 is a photo of the customer. {refs} reference photos of one jewellery piece{name}, possibly from different angles.{details}

Edit image 1 so the customer is wearing this exact piece {PLACEMENT.get(req.category, PLACEMENT['other'])}.

Rules:
- Reproduce the piece faithfully: same design, motif, metal colour, stone count, stone colours, chain style and proportions as the reference photos. Do not invent, simplify or restyle any part of it.
- Scale it realistically to the customer's body.
- Match the lighting, shadows and reflections of image 1, with contact shadows where the piece touches skin.
- Keep everything else in image 1 unchanged: the face, identity, expression, skin, hair, clothing, pose, background and framing. Remove any jewellery already worn in the same spot.
- Output one photorealistic image with the same framing as image 1."""


class GeminiRenderer:
    name = "gemini"

    def __init__(self, api_key: str | None = None, model: str | None = None):
        from google import genai

        self.client = genai.Client(api_key=api_key or config.GEMINI_API_KEY)
        self.model = model or config.GEMINI_IMAGE_MODEL

    def render(self, req: RenderRequest) -> Image.Image:
        from google.genai import types

        from .imaging import fit, to_jpeg

        parts = [
            types.Part.from_bytes(data=to_jpeg(fit(img)), mime_type="image/jpeg")
            for img in [req.person, *req.product_images]
        ]
        response = self.client.models.generate_content(
            model=self.model,
            contents=[*parts, build_prompt(req)],
            config=types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"]),
        )
        for part in response.parts or []:
            if part.inline_data and part.inline_data.data:
                from .imaging import load_image

                return load_image(part.inline_data.data)
        text = " ".join(p.text for p in (response.parts or []) if p.text)
        raise RenderError(f"Model returned no image. {text}".strip())


class MockRenderer:
    """Offline renderer for development and tests: pastes the first product photo
    (with its light background knocked out) roughly where the category is worn.
    It does no AI and is labelled as a mock on the output."""

    name = "mock"

    # (x centre, y centre, width) as fractions of the person photo
    ANCHORS = {
        "necklace": (0.5, 0.72, 0.42),
        "pendant": (0.5, 0.75, 0.25),
        "earrings": (0.3, 0.45, 0.12),
        "maang_tikka": (0.5, 0.18, 0.12),
        "nose_pin": (0.55, 0.42, 0.05),
    }

    def render(self, req: RenderRequest) -> Image.Image:
        person = req.person.convert("RGB")
        product = req.product_images[0].convert("RGB")
        cx, cy, w = self.ANCHORS.get(req.category, (0.5, 0.6, 0.3))

        # Treat near-white pixels as background.
        gray = product.convert("L")
        mask = gray.point(lambda v: 0 if v > 235 else 255).filter(ImageFilter.GaussianBlur(1))
        if mask.getbbox():
            box = mask.getbbox()
            product, mask = product.crop(box), mask.crop(box)

        target_w = max(8, int(person.width * w))
        target_h = max(8, int(product.height * target_w / product.width))
        product = product.resize((target_w, target_h))
        mask = mask.resize((target_w, target_h))
        pos = (int(person.width * cx - target_w / 2), int(person.height * cy - target_h / 2))

        out = person.copy()
        out.paste(product, pos, ImageChops.multiply(mask, mask))
        ImageDraw.Draw(out).text((10, 10), "MOCK RENDER (no AI)", fill=(255, 0, 0))
        return out


def get_renderer(name: str | None = None) -> Renderer:
    name = name or config.RENDERER
    if name == "gemini":
        return GeminiRenderer()
    if name == "mock":
        return MockRenderer()
    raise ValueError(f"Unknown renderer: {name}")
