# Product Try-On — Plan (Jewellery first)

Goal: a white-label service we sell to jewellers (later clothing, eyewear, etc.).
The jeweller uploads each product from a few angles once. Their customer uploads
a selfie, picks a piece, and gets back a realistic photo of themselves wearing it.

---

## 1. How the AI part works

The hard part with jewellery is **fidelity**, not realism. Image models produce
believable photos but tend to "redesign" the piece: they change the stone count,
the motif or the chain pattern. A jeweller will reject a try-on that doesn't
show *their* design. So we use two rendering modes behind one API:

| Mode | How | Good at | Weak at |
|---|---|---|---|
| **A. Generative edit** | Send the customer photo plus 2–4 product angle shots to a multi-image editing model (Gemini 3 Pro Image / "Nano Banana Pro", GPT-image, FLUX Kontext) with a category prompt | Natural lighting, skin contact, drape, works for any pose | Can alter fine design details |
| **B. Guided composite** | Detect landmarks (MediaPipe face mesh / pose / hands) → warp the real product cutout onto the neck, ears or finger → run a low-strength AI pass *only* on the edges for shadows and blending | Pixel-exact design, cheap | Needs a clean front-facing cutout per product; harder for side poses |

**Ship mode A first** because it can be built in days. Test it on 20–30 of the
client's real SKUs. Add mode B (or a hybrid: generate, then paste the original
product pixels back over the result) for the categories where A drifts. Necklaces
and earrings usually need B; rings and bangles are fine with A.

### Pipeline

```
Jeweller uploads product (3–5 angles)
  → background removal (rembg / SAM) → clean PNG cutouts
  → tag category + real size (e.g. necklace length 16", earring drop 4 cm)
  → stored per tenant

Customer uploads selfie
  → checks: face visible, neck/ears/hand visible for the category, resolution
  → landmarks (MediaPipe) → crop + scale hints
  → render (mode A or B by category)
  → automatic QA: compare the result's product region with the catalog cutout
     (CLIP/DINO similarity); retry or fall back if it is too low
  → watermark + "Book / Buy / Share on WhatsApp" buttons
```

Per-category prompts and placement rules live in config: necklace, earrings,
ring, bangle/bracelet, nose pin, maang tikka, mangalsutra, and so on. Clothing
later plugs in as another renderer (FASHN / Kling try-on APIs) behind the same
interface.

---

## 2. Delivery channel

One backend, two front-ends. **No native app**: customers won't install an app
for one jeweller.

1. **Mobile web app (primary)**: opened from a link or QR code in the shop, on
   Instagram, or in the client's website (embed or Shopify app). It does the
   catalog browsing, the upload, a before/after slider and "share to WhatsApp".
   It is also where the jeweller's admin dashboard lives.
2. **WhatsApp bot (front door)**: uses the WhatsApp Business Cloud API. The
   customer messages the store number, the bot sends a catalog list, the
   customer sends a selfie and gets the photo back in about 20 seconds. It works
   very well in India, where the purchase conversation already happens on
   WhatsApp. Messages a customer starts are cheap to answer inside the 24-hour
   window; marketing templates cost per message.
3. **In-store kiosk / tablet (later)**: the same web app in kiosk mode.

---

## 3. Existing solutions (what we compete with)

| Product | What it is | Price (approximate, verify) |
|---|---|---|
| mirrAR | Live AR jewellery try-on, Indian brands (Jos Alukkas, in-store mirrors) | ~$99–$599/mo + setup fee |
| Perfect Corp | AR/AI try-on, rings/earrings/bracelets; QWEEN (India) 2026 | ~$399–$799/mo, enterprise custom |
| Looksy | Photo-based try-on widget for rings/necklaces/earrings | tiered from 1,000 try-ons/mo |
| TryOnMe Jewels | Shopify app, earrings/necklaces | from ~$20/mo |
| NeuroViz, Fashion Diffusion | On-model *catalog photos* for sellers, not for shoppers | pay-as-you-go |
| FASHN, Kling | Clothing try-on APIs | ~$0.07–$0.30 per image |

The gap we fill: no one has a **WhatsApp-native** jewellery try-on with the
customer's real photo, run as a cheap white-label service for small and mid-size
Indian jewellers who don't have Shopify or a 3D-modelled catalog.

We build our own product on the same workflow. We don't copy competitors' code,
UI, branding or 3D assets; the workflow itself is not protected.

---

## 4. Tech stack

- **Web + admin:** Next.js (TypeScript), Tailwind, multi-tenant (`tenant` → `products` → `product_images`)
- **API + workers:** Python FastAPI, with a Redis/RQ or Celery queue (a render takes 10–30 s)
- **Vision:** MediaPipe (landmarks), rembg/SAM (cutouts), OpenCV (warp/composite)
- **Generation:** Gemini image API as the default, with the provider behind an interface so we can switch models
- **Storage/DB:** Postgres (Supabase) and S3 or Cloudflare R2 with signed URLs
- **WhatsApp:** Meta Cloud API webhook → the same render queue
- **Hosting:** Vercel (web) and Railway/Fly/Cloud Run (API + workers)

**Unit cost:** about $0.04–$0.13 per generated image, depending on the model and
resolution, plus retries. Sell monthly plans that include a try-on quota (for
example 500, 2,000 or 10,000 try-ons) with overage charges.

---

## 5. Privacy and compliance (must have)

- Selfies are personal data under India's DPDP Act 2023. Get explicit consent
  at upload, delete the photos automatically after N days (for example 7), and
  never use them for training.
- Watermark the outputs and label them as AI-generated previews ("actual piece
  may vary").
- Each tenant's data is isolated.

---

## 6. Roadmap

| Phase | Scope | Time |
|---|---|---|
| 0. Spike | Script: selfie plus product angles → Gemini → result. Test on 30 real SKUs, measure fidelity | 3–5 days |
| 1. MVP | Admin upload, mobile web try-on, mode A, QA check, one pilot jeweller | 3–4 weeks |
| 2. WhatsApp | Cloud API bot, catalog list messages, lead capture to the jeweller | +2 weeks |
| 3. Fidelity | Mode B composite/hybrid for necklaces and earrings, size-accurate scaling | +3 weeks |
| 4. Scale | Billing, multiple tenants, Shopify/website embed, analytics (try-ons → enquiries) | +3–4 weeks |
| 5. More categories | Clothing (FASHN/Kling), eyewear, watches | later |

### Inputs needed from the client
- 20–30 SKUs across categories, each shot from 3–5 angles on a plain background
- Real dimensions per product
- 10–20 sample customer-style selfies (with consent) for testing
