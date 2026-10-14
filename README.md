# Product Try-On

A white-label virtual try-on service for jewellers. Each jeweller (a "store") gets:

- **A customer page** at `/s/<store>`. Customers browse the collection, pick a
  piece, upload a selfie and get a photo of themselves wearing it. On the
  **"Try your own piece"** tab they can instead upload photos of any jewellery
  and try that on.
- **An admin page** at `/admin/<store>`. The jeweller adds products (details and
  3–5 photos from different angles), or **imports the catalogue from their
  existing website** (Shopify, WooCommerce, or any product page with structured
  data), and sets the WhatsApp number used for enquiries.

Everything after the customer clicks "Try it on" is automated: photo checks,
AI render, watermark, and the result with "Ask on WhatsApp".

See [PLAN.md](PLAN.md) for the product plan, competitors and roadmap.

## Run it

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env              # add GEMINI_API_KEY for real renders
set -a; . ./.env; set +a
.venv/bin/uvicorn app.main:app --reload
```

Without `GEMINI_API_KEY` the app uses the **mock renderer**, which pastes the
product photo onto the selfie (no AI). It is labelled "MOCK RENDER" so it is
never mistaken for a real result. Use it to try the flow end to end.

Create a store (this prints the admin token):

```bash
.venv/bin/python -m scripts.create_store demo "Demo Jewellers" --whatsapp "+91 98765 43210"
```

Then open `http://localhost:8000/admin/demo`, paste the token, and add or import
products. Customers use `http://localhost:8000/s/demo`.

## Getting a catalogue

1. **The jeweller's own website (best):** use *Import from your website* in the
   admin page, or call `POST /api/stores/<slug>/import {"url": ..., "limit": 50}`.
   The importer tries:
   - Shopify (`/products.json`, including `/collections/<x>`)
   - the WooCommerce Store API (`/wp-json/wc/store/v1/products`)
   - the page's schema.org `Product` JSON-LD, then Open Graph tags

   It downloads up to 5 photos per product and guesses the category from the
   product's name, type and tags. It also knows Indian terms such as jhumka,
   kada, haar, payal, nath and maang tikka. Only import from sites the client
   owns or has permission to use.
2. **The admin upload form**, for products not online yet.
3. **An open dataset for demos**, while there is no client. Download one, for example:
   - [sidd707/jewelry-design-dataset](https://huggingface.co/datasets/sidd707/jewelry-design-dataset): about 6.1k images (necklace, earring, bracelet, ring), MIT
   - [bzcasper/ai-tool-pool-jewelry-vision](https://huggingface.co/datasets/bzcasper/ai-tool-pool-jewelry-vision): about 5.1k images in 5 categories, CC BY 4.0
   - [Tanishq Jewellery Dataset (Kaggle)](https://www.kaggle.com/datasets/sapnilpatel/tanishq-jewellery-dataset): rings and necklaces, MIT

   Check each licence on its page before using it. Then load the images:

   ```bash
   .venv/bin/python -m scripts.seed_from_folder ~/datasets/jewellery --store demo --limit 200 --create "Demo Jewellers"
   ```

   The script accepts `<category>/<images>`, `<category>/<product>/<angle images>`,
   or a flat folder with an optional `metadata.csv`.

## How the render works

`app/renderers.py` sends the customer photo and the product photos to a
multi-image editing model (Gemini image models by default; set
`GEMINI_IMAGE_MODEL`). The prompt is specific to each category: it says where the
piece is worn, tells the model to reproduce the design exactly (stones, motif,
metal, chain) and to keep the face, clothes and background unchanged. A new
renderer (for example a landmark-guided compositor for exact necklace fidelity,
or a clothing try-on API) only needs a `render(RenderRequest) -> Image` method.

## Privacy

- Customers must tick a consent box before uploading.
- Selfies, uploaded pieces and results are deleted after `RETENTION_DAYS`
  (default 7).
- Results are watermarked "AI preview".
- Admin routes need the store's token.
- URL imports refuse private and internal network addresses.

## Layout

```
app/main.py        API + page routes
app/db.py          SQLAlchemy models (Store, Product, ProductImage, TryOn)
app/renderers.py   prompts, Gemini renderer, mock renderer
app/tryon.py       background job + retention purge
app/importers.py   website catalogue import
app/netsafe.py     HTTP client that blocks internal addresses
web/               customer + admin pages (vanilla JS)
scripts/           create_store, seed_from_folder
tests/             pytest
```

Run the tests with `.venv/bin/python -m pytest -q`.

## Not built yet

- WhatsApp bot (Meta Cloud API webhook → same try-on job)
- Job queue (renders currently run as in-process background tasks)
- S3/R2 storage
- Rate limiting
- Billing
- Landmark-guided compositing for necklaces and earrings
