# Design brief: "Maison"

The storefront must feel like the website of an international fine-jewellery
house (think Cartier, Tiffany & Co., Bulgari, Messika, Mejuri), not a SaaS
widget. The jeweller's own tools (studio, onboarding) share the same aesthetic
in a calmer, functional form.

## Principles
- **Quiet luxury.** Ivory and ink with a single champagne-gold accent, used sparingly
  (rules, active states, small ornaments). No gradients, no bright colours, no
  emoji, no heavy shadows, no pill buttons or chips.
- **Typography carries the brand.** Cormorant Garamond Light for display (large, airy,
  sometimes italic for one emphasised word). Jost for body and UI. Small
  UPPERCASE labels with wide letter-spacing (`.eyebrow`, buttons, nav).
- **Hairlines, not boxes.** 1px `--line` rules and borders, square corners
  (`--radius: 2px`). Inputs are underline-only.
- **Generous whitespace.** Sections breathe (`--space-8`/`--space-9` vertical rhythm on desktop).
- **Photography first.** Product images sit on a soft `--well` background, `object-fit: contain`,
  with a slow 1.04 zoom on hover. Consistent aspect ratio 4:5.
- **Slow, subtle motion.** 300–600ms ease, fades and gentle rises; respect reduced motion.
- Mobile first (360px wide, 16px gutters, no horizontal scroll), excellent on desktop.

## Foundation
`web/css/base.css` holds the tokens and primitives: `.btn` (`-primary`, `-ghost`,
`-whatsapp`, `-danger`, `-sm`, `-block`, `.is-busy`), form fields (`.field`,
`.field-row`, `label`, `.hint`, `.check`), `.card`, `.badge`, `.msg-*`, `.stepper`,
`.eyebrow`, `.display`, `.lede`, `.ornament`, `.container`, `.narrow`. Every page
links it first, then its own stylesheet. Don't redefine tokens; add page-level
classes in the page stylesheet. Don't edit base.css (ask the lead if a primitive is missing).

## Copy tone
Short and refined. Write "Discover", "Try it on", "Your look", "Enquire on WhatsApp",
not "Upload now!!". Use sentence case for headings and small caps for labels.
Say "AI preview", never "fake".
