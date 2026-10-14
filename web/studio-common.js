/* Shared building blocks for the jeweller-facing pages (studio and onboarding):
   line icons, toasts, confirm dialog, photo tiles, product form, website importer, share panel. */
import {
  h, show, api, categoryLabel, copyText, shrinkImage, sleep, ANGLES, whatsappDigits,
} from "/static/common.js";

// ---------- icons (thin line, currentColor) ----------

const ICONS = {
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.7 4 5.7 4 9s-1.4 6.3-4 9c-2.6-2.7-4-5.7-4-9s1.4-6.3 4-9z"/>',
  gem: '<path d="M6.5 4h11L22 9.5 12 21 2 9.5z"/><path d="M2 9.5h20M9 4l-2 5.5L12 21l5-11.5L15 4M7 9.5L12 4l5 5.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  up: '<path d="M7 17L17 7M8 7h9v9"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  camera: '<path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="1"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4.5 4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  logout: '<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10"/>',
};

export function icon(name, size = 20) {
  const span = document.createElement("span");
  span.className = "icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
  return span;
}

// ---------- toasts ----------

let toastHost;
export function toast(message, kind = "ok") {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const el = h("div", { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : null }, icon(kind === "error" ? "close" : "check", 16), h("span", { text: message }));
  toastHost.append(el);
  const life = kind === "error" ? 6500 : 3800;
  setTimeout(() => {
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 400);
  }, life);
}

// ---------- confirm dialog ----------

export function confirmDialog({ title, body = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "dialog" });
    const ok = h("button", { type: "button", class: `btn ${danger ? "btn-danger" : "btn-primary"}`, text: confirmLabel });
    const no = h("button", { type: "button", class: "btn btn-ghost", text: cancelLabel });
    dlg.append(
      h("div", { class: "dialog-body" },
        h("h3", { text: title }),
        body ? h("p", { class: "dialog-text", text: body }) : null,
        h("div", { class: "dialog-actions" }, no, ok)));
    let result = false;
    ok.addEventListener("click", () => { result = true; dlg.close(); });
    no.addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
    no.focus();
  });
}

// ---------- small helpers ----------

export const customerLink = (slug) => `${location.origin}/s/${slug}`;
export const shareMessage = (slug) => `Try our jewellery on yourself before you buy: ${customerLink(slug)}`;
export const whatsappShareUrl = (text) => `https://wa.me/?text=${encodeURIComponent(text)}`;
export const SOURCE_LABELS = { manual: "Manual", import: "Imported", dataset: "Dataset" };
export const sourceLabel = (s) => SOURCE_LABELS[s] || categoryLabel(s || "manual");

export function adminTokenKey(slug) { return `tryon-admin-${slug}`; }

/** A "Saved" tick that fades in and out. */
export function savedTick() {
  const el = h("span", { class: "saved", "aria-live": "polite" });
  let timer;
  return {
    el,
    flash() {
      el.replaceChildren(icon("check", 14), "Saved");
      el.classList.add("on");
      clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove("on"), 2200);
    },
  };
}

export function field(label, control, hint) {
  return h("div", { class: "field" }, h("label", { for: control.id, text: label }), control,
    hint ? h("span", { class: "hint", text: hint }) : null);
}

export function textInput(id, attrs = {}) {
  return h("input", { id, type: "text", autocomplete: "off", ...attrs });
}

export function categorySelect(id, categories, selected, placeholder) {
  const sel = h("select", { id });
  if (placeholder) sel.append(h("option", { value: "", text: placeholder }));
  for (const c of categories) sel.append(h("option", { value: c, text: categoryLabel(c) }));
  sel.value = selected || "";
  return sel;
}

export function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Plain-language labels for each piece type, used in hints. */
export const PLACEMENT = {
  necklace: "neck", pendant: "neck", earrings: "ears", ring: "finger", bracelet: "wrist",
  bangle: "wrist", nose_pin: "nose", maang_tikka: "forehead", anklet: "ankle", other: "body",
};

// ---------- photo tiles: Front / Side / Back / Worn / Detail ----------

export function createPhotoTiles({ onChange = () => {} } = {}) {
  const slots = ANGLES.map((angle) => ({ angle, file: null, url: null }));
  const root = h("div", { class: "tiles" });

  function put(slot, file) {
    if (!file || !file.type.startsWith("image/")) return false;
    if (slot.url) URL.revokeObjectURL(slot.url);
    slot.file = file;
    slot.url = URL.createObjectURL(file);
    return true;
  }
  function distribute(startIndex, files) {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    let next = startIndex;
    list.forEach((file, n) => {
      let target = n === 0 ? startIndex : -1;
      if (n > 0) {
        for (let k = 0; k < slots.length; k++) {
          const idx = (next + k) % slots.length;
          if (!slots[idx].file && idx !== startIndex) { target = idx; break; }
        }
      }
      if (target >= 0) { put(slots[target], file); next = target + 1; }
    });
    render();
    onChange();
  }

  function render() {
    root.replaceChildren();
    slots.forEach((slot, i) => {
      const input = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, tabindex: "-1" });
      input.addEventListener("change", () => { distribute(i, input.files); input.value = ""; });
      const pick = h("button", {
        type: "button", class: "tile-pick",
        "aria-label": slot.file ? `Replace ${slot.angle} photo` : `Add ${slot.angle} photo`,
      }, slot.file ? h("img", { src: slot.url, alt: `${categoryLabel(slot.angle)} photo` }) : icon("plus", 22));
      pick.addEventListener("click", () => input.click());
      const frame = h("div", { class: `tile-frame${slot.file ? " is-filled" : ""}` }, pick, input);
      if (slot.file) {
        const rm = h("button", { type: "button", class: "tile-remove", "aria-label": `Remove ${slot.angle} photo` }, icon("close", 14));
        rm.addEventListener("click", () => { URL.revokeObjectURL(slot.url); slot.file = null; slot.url = null; render(); onChange(); });
        frame.append(rm);
      }
      for (const evt of ["dragenter", "dragover"]) {
        frame.addEventListener(evt, (e) => { e.preventDefault(); frame.classList.add("is-drop"); });
      }
      for (const evt of ["dragleave", "drop"]) frame.addEventListener(evt, () => frame.classList.remove("is-drop"));
      frame.addEventListener("drop", (e) => { e.preventDefault(); distribute(i, e.dataTransfer.files); });
      root.append(h("div", { class: "tile" }, frame, h("span", { class: "tile-label", text: categoryLabel(slot.angle) })));
    });
  }
  render();

  return {
    el: root,
    count: () => slots.filter((s) => s.file).length,
    async appendTo(form) {
      for (const s of slots) {
        if (!s.file) continue;
        form.append("images", await shrinkImage(s.file));
        form.append("angles", s.angle);
      }
    },
    reset() {
      slots.forEach((s) => { if (s.url) URL.revokeObjectURL(s.url); s.file = null; s.url = null; });
      render();
      onChange();
    },
  };
}

// ---------- add-a-piece form (compact in onboarding, full in the studio) ----------

/**
 * `create(formData)` posts the product and resolves with it. `categories` is the list of types.
 * `full` adds currency, dimensions, link and description and lays the photos beside the fields.
 */
export function buildProductForm({ categories, create, onAdded = () => {}, full = false, submitLabel = "Add this piece" }) {
  const uid = full ? "pf" : "pc";
  const name = textInput(`${uid}-name`, { maxlength: "300", placeholder: "e.g. Polki choker necklace" });
  const cat = categorySelect(`${uid}-cat`, categories, "", "Choose a type");
  const price = textInput(`${uid}-price`, { inputmode: "decimal", placeholder: "125000" });
  const currency = textInput(`${uid}-cur`, { value: "INR", maxlength: "5", autocapitalize: "characters" });
  const dims = textInput(`${uid}-dim`, { placeholder: "Length 18 in, pendant 3 cm" });
  const link = textInput(`${uid}-url`, { type: "url", placeholder: "https://yourwebsite.com/products/…" });
  const desc = h("textarea", { id: `${uid}-desc`, rows: "3" });
  const err = h("div", { role: "alert", hidden: true });
  const submit = h("button", { type: "submit", class: "btn btn-primary", text: submitLabel });
  const tiles = createPhotoTiles();

  const photos = h("div", { class: "pf-photos" },
    h("span", { class: "label", text: full ? "Photographs" : "Photographs (up to 5)" }),
    tiles.el,
    h("p", { class: "tip", text: "Tip: a plain, light background with the whole piece in frame works best. Front, side and worn views help most." }));

  const fields = h("div", { class: "pf-fields" },
    field("Name", name),
    h("div", { class: "field-row" }, field("Type", cat, full ? "Decides where the piece sits on your customer." : null), field(full ? "Price" : "Price (INR)", price)),
    ...(full ? [
      h("div", { class: "field-row" }, field("Currency", currency), field("Dimensions", dims)),
      field("Product link", link),
      field("Description", desc),
    ] : []),
    err);

  fields.append(h("div", { class: "pf-submit" }, submit));
  const form = h("form", { class: `pf${full ? " pf-full" : ""}`, novalidate: true }, photos, fields);

  const say = (text) => { err.textContent = text; err.className = text ? "msg msg-error" : ""; err.hidden = !text; };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    say("");
    if (!name.value.trim()) return say("Please give the piece a name.");
    if (!cat.value) return say("Please choose the type of jewellery.");
    if (tiles.count() === 0) return say("Please add at least one photograph.");
    submit.classList.add("is-busy"); submit.disabled = true;
    try {
      const fd = new FormData();
      fd.append("name", name.value.trim());
      fd.append("category", cat.value);
      fd.append("currency", (currency.value.trim() || "INR").toUpperCase());
      if (price.value.trim()) fd.append("price", price.value.trim());
      if (full) {
        for (const [k, el] of [["dimensions", dims], ["product_url", link], ["description", desc]]) {
          if (el.value.trim()) fd.append(k, el.value.trim());
        }
      }
      await tiles.appendTo(fd);
      const product = await create(fd);
      for (const el of [name, price, dims, link, desc]) el.value = "";
      cat.value = "";
      tiles.reset();
      toast(`${product.name} added to your collection`);
      onAdded(product);
    } catch (ex) {
      say(ex.message);
    } finally {
      submit.classList.remove("is-busy"); submit.disabled = false;
    }
  });
  return form;
}

// ---------- website importer ----------

const IMPORT_STAGES = ["Reading your website…", "Gathering product photographs…", "Adding pieces to your collection…", "Nearly there…"];

export function buildImporter({ call, base, defaultUrl = "", onDone = () => {}, idPrefix = "imp" }) {
  const url = textInput(`${idPrefix}-url`, { type: "url", placeholder: "https://yourwebsite.com", inputmode: "url" });
  url.value = defaultUrl;
  const limit = textInput(`${idPrefix}-limit`, { type: "number", min: "1", max: "200", inputmode: "numeric" });
  limit.value = "20";
  const stage = h("p", { class: "import-stage", "aria-live": "polite" });
  const progress = h("div", { class: "import-progress", hidden: true }, h("div", { class: "bar", "aria-hidden": "true" }), stage);
  const result = h("div", { class: "import-result", hidden: true, "aria-live": "polite" });
  const err = h("div", { role: "alert", hidden: true });
  const btn = h("button", { type: "submit", class: "btn btn-primary", text: "Import pieces" });

  const say = (text) => { err.textContent = text; err.className = text ? "msg msg-error" : ""; err.hidden = !text; };
  const fact = (label, value, accent) => h("div", { class: `fact${accent ? (value > 0 ? " fact-accent" : " fact-zero") : ""}` }, h("span", { class: "fact-num", text: String(value) }), h("span", { class: "eyebrow", text: label }));

  const form = h("form", { class: "importer", novalidate: true },
    h("div", { class: "field-row importer-row" },
      field("Website or product page", url, "Shopify, WooCommerce, or any page that lists your products."),
      field("How many pieces", limit)),
    h("p", { class: "small" }, "Please import only from a website you own or have permission to use."),
    progress, result, err,
    h("div", { class: "form-actions" }, btn));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    say(""); result.hidden = true;
    let address = url.value.trim();
    if (!address) return say("Please enter your website address.");
    if (!/^https?:\/\//i.test(address)) { address = `https://${address}`; url.value = address; }
    const n = Math.max(1, Math.min(200, parseInt(limit.value, 10) || 20));
    btn.classList.add("is-busy"); btn.disabled = true;
    progress.hidden = false;
    let i = 0;
    stage.textContent = IMPORT_STAGES[0];
    const timer = setInterval(() => { i = Math.min(i + 1, IMPORT_STAGES.length - 1); stage.textContent = IMPORT_STAGES[i]; }, 7000);
    try {
      const r = await call(`${base}/import`, { method: "POST", json: { url: address, limit: n } });
      result.replaceChildren(
        h("div", { class: "facts" }, fact("Found", r.found), fact("Imported", r.imported, true), fact("Already here", r.skipped_existing), fact("Unavailable", r.failed)),
        r.imported === 0 ? h("p", { class: "small", text: r.found === 0 ? "We could not find products on that page. Try your shop or collection page, or add pieces by hand." : "Nothing new was added." }) : null);
      result.hidden = false;
      if (r.imported > 0) toast(`${r.imported} piece${r.imported === 1 ? "" : "s"} imported`);
      onDone(r);
    } catch (ex) {
      say(ex.message);
    } finally {
      clearInterval(timer);
      progress.hidden = true;
      btn.classList.remove("is-busy"); btn.disabled = false;
    }
  });
  return form;
}

// ---------- share panel: link, QR, ready-to-paste message ----------

export function buildSharePanel({ slug, wide = false, idPrefix = "sh" }) {
  const link = customerLink(slug);
  const message = shareMessage(slug);
  const qrUrl = `/api/stores/${encodeURIComponent(slug)}/qr.png`;

  const linkInput = h("input", { id: `${idPrefix}-link`, type: "text", readonly: true, value: link, "aria-label": "Customer link" });
  linkInput.addEventListener("focus", () => linkInput.select());
  const copy = h("button", { type: "button", class: "btn btn-sm", text: "Copy" });
  copy.addEventListener("click", () => { copyText(link, copy); toast("Link copied"); });
  const open = h("a", { class: "btn btn-sm", href: `/s/${encodeURIComponent(slug)}`, target: "_blank", rel: "noopener" }, "Open", icon("up", 14));

  const qr = h("figure", { class: "qr-card" },
    h("div", { class: "qr-frame" }, h("img", { src: qrUrl, alt: "QR code linking to your boutique", width: "180", height: "180" })),
    h("figcaption", { class: "small", text: "Print it for the counter, the box or the window." }),
    h("a", { class: "btn btn-sm", href: qrUrl, download: `${slug}-qr.png` }, icon("download", 14), "Download QR"));

  const text = h("textarea", { id: `${idPrefix}-msg`, rows: "4" });
  text.value = message;
  const copyMsg = h("button", { type: "button", class: "btn", text: "Copy message" });
  copyMsg.addEventListener("click", () => { copyText(text.value, copyMsg); toast("Message copied"); });
  const wa = h("a", { class: "btn btn-whatsapp", target: "_blank", rel: "noopener", text: "Share on WhatsApp" });
  const syncWa = () => { wa.href = whatsappShareUrl(text.value); };
  text.addEventListener("input", syncWa);
  syncWa();

  return h("div", { class: `share${wide ? " share-wide" : ""}` },
    h("div", { class: "share-link" },
      h("label", { for: linkInput.id, text: "Customer link" }),
      h("div", { class: "link-row" }, linkInput, copy, open)),
    h("div", { class: "share-grid" },
      qr,
      h("div", { class: "share-msg" },
        h("label", { for: text.id, text: "Ready-to-paste message" }),
        text,
        h("div", { class: "btn-row" }, copyMsg, wa))));
}

export { sleep, show, whatsappDigits };
