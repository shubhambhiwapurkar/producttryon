/* Onboarding wizard for jewellers: create a store, add products, check them, test, go live. */
import {
  $, h, show, setMsg, busy, api, storageGet, storageSet, categoryLabel, formatPrice, slugify, copyText,
  shrinkImage, createCompare, createProgress, startProgressMessages, runTryOn, renderStepper,
  createPhotoSlots, TIPS,
} from "/static/common.js";

const STEPS = ["Your store", "Add products", "Check catalogue", "Try it yourself", "You're live"];
const KEY = "tryon-onboard";

const S = {
  step: 0,
  slug: "",
  token: "",
  ackKey: false, // admin key saved
  later: false, // "Do this later" chosen on step 2
  mode: "", // import | upload | later
  openSignup: true,
  categories: [],
  products: [],
  form: { name: "", wa: "", web: "", code: "" },
  tryProductId: null,
  selfie: null,
  run: 0,
  stopMessages: null,
  hasResult: false,
};

const created = () => Boolean(S.slug && S.token);
const call = (path, options = {}) => api(path, { ...options, token: S.token });
const base = () => `/api/stores/${encodeURIComponent(S.slug)}`;
const customerLink = () => `${location.origin}/s/${S.slug}`;

// ---------- persistence ----------

function save() {
  storageSet(KEY, JSON.stringify({ slug: S.slug, token: S.token, step: S.step, ackKey: S.ackKey, later: S.later }));
}

function load() {
  try { return JSON.parse(storageGet(KEY) || "null"); } catch (e) { return null; }
}

function saveAdminToken() { storageSet(`tryon-admin-${S.slug}`, S.token); }

function startOver() {
  S.run++;
  storageSet(KEY, null);
  Object.assign(S, {
    step: 0, slug: "", token: "", ackKey: false, later: false, mode: "", products: [],
    form: { name: "", wa: "", web: "", code: "" }, tryProductId: null, selfie: null, hasResult: false,
  });
  render();
}

// ---------- small UI helpers ----------

function field(label, control, hint) {
  const id = control.id;
  return h("div", { class: "field" }, h("label", { for: id, text: label }), control,
    hint ? h("span", { class: "hint", text: hint }) : null);
}

function input(id, attrs = {}) {
  return h("input", { id, type: "text", autocomplete: "off", ...attrs });
}

function categorySelect(id, selected, placeholder) {
  const sel = h("select", { id });
  if (placeholder) sel.append(h("option", { value: "", text: placeholder }));
  for (const c of S.categories) sel.append(h("option", { value: c, text: categoryLabel(c) }));
  sel.value = selected || "";
  return sel;
}

function guard(err, box) {
  if (err.unauthorized) {
    setMsg($("global-error"), "Your admin key is no longer valid. Please start over.");
    return;
  }
  setMsg(box || $("global-error"), err.message);
}

// ---------- navigation ----------

function isValid() {
  switch (S.step) {
    case 0: return created()
      ? S.ackKey
      : Boolean(S.form.name.trim()) && (S.openSignup || Boolean(S.form.code.trim()));
    case 1: return S.products.length >= 1 || S.later;
    default: return true;
  }
}

function updateNav() {
  const back = $("btn-back");
  const next = $("btn-next");
  back.disabled = S.step === 0;
  show(next, S.step < STEPS.length - 1);
  next.disabled = !isValid();
  if (S.step === 0) next.textContent = created() ? "Continue" : "Create my store";
  else if (S.step === 3) next.textContent = S.hasResult ? "Next" : "Skip for now";
  else next.textContent = "Next";
}

function go(step) {
  S.run++; // cancel any running try-on poll
  if (S.stopMessages) S.stopMessages();
  S.step = Math.max(0, Math.min(STEPS.length - 1, step));
  save();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function onNext() {
  setMsg($("global-error"), "");
  if (S.step === 0 && !created()) return busy($("btn-next"), createStore);
  if (isValid()) go(S.step + 1);
}

// ---------- step 1: your store ----------

async function createStore() {
  const f = S.form;
  const payload = { name: f.name.trim() };
  if (f.wa.trim()) payload.whatsapp_number = f.wa.trim();
  if (f.web.trim()) payload.website_url = f.web.trim();
  if (!S.openSignup) payload.invite_code = f.code.trim();
  try {
    const store = await api("/api/signup", { method: "POST", json: payload });
    S.slug = store.slug;
    S.token = store.admin_token;
    S.storeName = store.name;
    S.ackKey = false;
    saveAdminToken();
    save();
    render();
  } catch (err) {
    setMsg($("global-error"), err.status === 403
      ? "That invite code isn't valid. Please check it with the person who invited you."
      : err.message);
  }
}

function renderStoreStep(body) {
  body.append(h("h2", { text: "Your store" }));
  if (created()) return renderCreated(body);

  body.append(h("p", { class: "lead", text: "Tell us about your jewellery business." }));
  const preview = h("div", { class: "link-preview", "aria-live": "polite" });
  const updatePreview = () => {
    preview.replaceChildren("Your customers will visit: ",
      h("strong", { text: `${location.origin}/s/${slugify(S.form.name)}` }));
  };
  const bind = (el, key) => {
    el.value = S.form[key];
    el.addEventListener("input", () => { S.form[key] = el.value; updatePreview(); updateNav(); });
    return el;
  };
  const name = bind(input("f-name", { required: true, maxlength: "200", placeholder: "e.g. Sharma Jewellers" }), "name");
  body.append(
    field("Store name", name),
    preview,
    field("WhatsApp number", bind(input("f-wa", { type: "tel", placeholder: "+91 98765 43210" }), "wa"),
      "Customers will message you here when they love a piece."),
    field("Website (optional)", bind(input("f-web", { type: "url", placeholder: "https://yourstore.com" }), "web"),
      "We can import your products from it in the next step."));
  if (!S.openSignup) {
    body.append(field("Invite code", bind(input("f-code", { required: true }), "code"),
      "Sign-up is by invitation. Enter the code you were given."));
  }
  updatePreview();
}

function renderCreated(body) {
  body.append(
    h("p", { class: "lead", text: `Your store "${storeNameFromState()}" is created.` }),
    h("div", { class: "link-preview" }, "Your customer link: ", h("strong", { text: customerLink() })));
  const copyBtn = h("button", { type: "button", class: "btn", id: "copy-key", text: "Copy" });
  copyBtn.addEventListener("click", () => copyText(S.token, copyBtn));
  const ack = h("input", { type: "checkbox", id: "ack-key" });
  ack.checked = S.ackKey;
  ack.addEventListener("change", () => { S.ackKey = ack.checked; save(); updateNav(); });
  body.append(h("div", { class: "callout", role: "group", "aria-label": "Your admin key" },
    h("h3", { text: "Your admin key" }),
    h("p", { text: "Save this key — you need it to manage your store." }),
    h("div", { class: "key-box" }, h("code", { id: "admin-key", text: S.token }), copyBtn),
    h("div", { class: "check" }, ack, h("label", { for: "ack-key", text: "I've saved it" }))));
}

function storeNameFromState() { return S.storeName || S.form.name.trim() || S.slug; }

// ---------- step 2: add products ----------

function productCountText() {
  const n = S.products.length;
  return `${n} product${n === 1 ? "" : "s"} added`;
}

async function refreshProducts() {
  try {
    S.products = await api(`${base()}/products`);
  } catch (err) { guard(err); }
  const pill = $("prod-count");
  if (pill) { pill.textContent = productCountText(); show(pill, S.products.length > 0); }
  updateNav();
}

function renderProductsStep(body) {
  body.append(h("h2", { text: "Add your products" }),
    h("p", { class: "lead", text: "Use either option, or both. You can always add more later from your dashboard." }));

  const choices = [
    ["import", "Import from my website", "Shopify, WooCommerce or any product page"],
    ["upload", "Upload products", "Add photos and details yourself"],
    ["later", "Do this later", "Skip for now"],
  ];
  const grid = h("div", { class: "choice-grid", role: "group", "aria-label": "How do you want to add products?" });
  const panel = h("div", { id: "mode-panel" });
  const pill = h("div", { class: "count-pill", id: "prod-count", role: "status", text: productCountText() });
  show(pill, S.products.length > 0);

  const paint = () => {
    grid.replaceChildren();
    for (const [key, title, sub] of choices) {
      const b = h("button", { type: "button", class: "choice", "aria-pressed": String(S.mode === key) },
        h("strong", { text: title }), h("span", { text: sub }));
      b.addEventListener("click", () => {
        S.mode = key;
        S.later = key === "later";
        save();
        paint();
        updateNav();
      });
      grid.append(b);
    }
    panel.replaceChildren();
    if (S.mode === "import") panel.append(importPanel());
    if (S.mode === "upload") panel.append(uploadPanel());
    if (S.mode === "later") {
      panel.append(h("div", { class: "msg msg-info", text: "No problem. You can add products any time from your dashboard. Your customers can still try on their own pieces." }));
    }
  };
  body.append(grid, panel, pill);
  paint();
  refreshProducts();
}

function importPanel() {
  const url = input("imp-url", { type: "url", placeholder: "https://yourstore.com or a product page" });
  url.value = S.form.web.trim() || S.websiteUrl || "";
  const limit = input("imp-limit", { type: "number", min: "1", max: "200" });
  limit.value = "20";
  const out = h("div", { role: "status", "aria-live": "polite" });
  const spin = h("div", { class: "inline-status" }, h("span", { class: "spinner", "aria-hidden": "true" }),
    h("span", { text: "Importing… this can take a minute. Please keep this page open." }));
  show(spin, false);
  const btn = h("button", { type: "button", class: "btn btn-primary", text: "Import products" });
  btn.addEventListener("click", async () => {
    setMsg(out, "");
    if (!url.value.trim()) return setMsg(out, "Please enter your website address.");
    show(spin, true);
    await busy(btn, async () => {
      try {
        const n = Math.max(1, Math.min(200, parseInt(limit.value, 10) || 20));
        const r = await call(`${base()}/import`, { method: "POST", json: { url: url.value.trim(), limit: n } });
        setMsg(out, `Found ${r.found} • Imported ${r.imported} • Already added ${r.skipped_existing} • Failed ${r.failed}`,
          r.imported > 0 ? "ok" : "info");
        await refreshProducts();
      } catch (err) { guard(err, out); } finally { show(spin, false); }
    });
  });
  return h("div", {},
    field("Website or product page", url),
    field("How many products?", limit),
    h("p", { class: "hint", text: "Only import from websites you own or have permission to use." }),
    spin, out, btn);
}

function uploadPanel() {
  const name = input("up-name", { maxlength: "300", placeholder: "e.g. Kundan necklace" });
  const cat = categorySelect("up-cat", "", "Choose a type…");
  const price = input("up-price", { inputmode: "decimal", placeholder: "1250" });
  const files = h("input", { type: "file", id: "up-files", accept: "image/*", multiple: true, hidden: true });
  const list = h("div", { id: "up-slots" });
  const add = h("button", { type: "button", class: "btn btn-sm", text: "Add photos" });
  const out = h("div", { role: "status", "aria-live": "polite" });
  const btn = h("button", { type: "submit", class: "btn btn-primary", text: "Save product" });
  const slots = createPhotoSlots({ container: list, fileInput: files, addButton: add, onNotice: (t) => setMsg(out, t, "info") });

  const form = h("form", { novalidate: true },
    field("Name", name), field("Type", cat), field("Price (INR)", price),
    h("div", { class: "field" }, h("span", { class: "label", text: "Photos (1–5)" }),
      h("span", { class: "hint", text: "Plain light background, whole piece in frame, 3–5 angles give the best results." }),
      list, files, h("div", {}, add)),
    out, btn);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setMsg(out, "");
    if (!name.value.trim()) return setMsg(out, "Please enter a name.");
    if (!cat.value) return setMsg(out, "Please choose the type of jewellery.");
    if (slots.photos.length === 0) return setMsg(out, "Please add at least one photo.");
    const fd = new FormData();
    fd.append("name", name.value.trim());
    fd.append("category", cat.value);
    fd.append("currency", "INR");
    if (price.value.trim()) fd.append("price", price.value.trim());
    slots.appendTo(fd);
    await busy(btn, async () => {
      try {
        const p = await call(`${base()}/products`, { method: "POST", body: fd });
        name.value = ""; price.value = ""; cat.value = "";
        slots.reset();
        setMsg(out, `Saved "${p.name}". Add another, or press Next.`, "ok");
        await refreshProducts();
      } catch (err) { guard(err, out); }
    });
  });
  return form;
}

// ---------- step 3: check catalogue ----------

function renderCatalogueStep(body) {
  body.append(h("h2", { text: "Check your catalogue" }),
    h("p", { class: "lead", text: "We guessed each product's type from its name — fix any that look wrong; the type decides where the piece is placed on the customer." }));
  if (S.products.length === 0) {
    body.append(h("div", { class: "empty", text: "No products yet. Go back to add some, or continue and add them later." }));
    return;
  }
  const grid = h("div", { class: "edit-grid" });
  for (const p of S.products) grid.append(editCard(p, grid));
  body.append(grid);
}

function editCard(p, grid) {
  const tick = h("span", { class: "saved-tick", "aria-live": "polite" });
  const err = h("div", { role: "alert" });
  const name = input(`ed-name-${p.id}`, { maxlength: "300", "aria-label": `Name of ${p.name}` });
  name.value = p.name;
  const cat = categorySelect(`ed-cat-${p.id}`, p.category);
  cat.setAttribute("aria-label", `Type of ${p.name}`);
  const price = input(`ed-price-${p.id}`, { inputmode: "decimal", placeholder: "Price", "aria-label": `Price of ${p.name}` });
  price.value = p.price || "";

  let timer;
  const patch = async (field, value, el) => {
    setMsg(err, "");
    if (field === "name" && !value.trim()) { el.value = p.name; return; }
    if (String(p[field] ?? "") === value) return;
    try {
      const updated = await call(`${base()}/products/${p.id}`, { method: "PATCH", json: { [field]: value } });
      Object.assign(p, updated);
      tick.textContent = "✓ Saved";
      tick.classList.add("on");
      clearTimeout(timer);
      timer = setTimeout(() => tick.classList.remove("on"), 2000);
    } catch (e) {
      el.value = p[field] ?? "";
      guard(e, err);
    }
  };
  name.addEventListener("change", () => patch("name", name.value.trim(), name));
  cat.addEventListener("change", () => patch("category", cat.value, cat));
  price.addEventListener("change", () => patch("price", price.value.trim(), price));

  const del = h("button", { type: "button", class: "btn btn-sm btn-danger", text: "Delete", "aria-label": `Delete ${p.name}` });
  del.addEventListener("click", async () => {
    if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    await busy(del, async () => {
      try {
        await call(`${base()}/products/${p.id}`, { method: "DELETE" });
        S.products = S.products.filter((x) => x.id !== p.id);
        card.remove();
        if (S.products.length === 0) render();
        updateNav();
      } catch (e) { guard(e, err); }
    });
  });

  const img = p.images[0];
  const card = h("div", { class: "edit-card" },
    img ? h("img", { src: img.url, alt: p.name, loading: "lazy" }) : h("div"),
    h("div", { class: "fields" }, name,
      h("div", { class: "row" }, cat, price, tick),
      h("div", { class: "row" }, h("span", { class: "hint", text: formatPrice(p) }), del), err));
  return card;
}

// ---------- step 4: try it yourself ----------

function renderTryStep(body) {
  body.append(h("h2", { text: "Try it yourself" }),
    h("p", { class: "lead", text: "See what your customers will see. Pick a piece and upload your own photo. (You can skip this.)" }));
  if (S.products.length === 0) {
    body.append(h("div", { class: "empty", text: "Add a product first to test it. You can skip this step." }));
    return;
  }
  if (!S.products.some((p) => p.id === S.tryProductId)) S.tryProductId = S.products[0].id;

  const area = h("div", { id: "try-area" });
  const pickGrid = h("div", { class: "pick-grid", role: "group", "aria-label": "Choose a product to try" });
  const paintPicks = () => {
    pickGrid.replaceChildren();
    for (const p of S.products) {
      const b = h("button", { type: "button", class: "pick", "aria-pressed": String(p.id === S.tryProductId), title: p.name },
        p.images[0] ? h("img", { src: p.images[0].url, alt: "" }) : null, h("span", { text: p.name }));
      b.addEventListener("click", () => { S.tryProductId = p.id; paintPicks(); paintTip(); });
      pickGrid.append(b);
    }
  };
  const tip = h("div", { class: "tip-box" });
  const paintTip = () => {
    const p = S.products.find((x) => x.id === S.tryProductId);
    tip.replaceChildren(h("strong", { text: "Best photo: " }), TIPS[p ? p.category : "other"] || TIPS.other);
  };

  const camera = h("input", { type: "file", accept: "image/*", capture: "user", hidden: true, id: "try-camera" });
  const gallery = h("input", { type: "file", accept: "image/*", hidden: true, id: "try-gallery" });
  const take = h("button", { type: "button", class: "btn", text: "Take a selfie" });
  const choose = h("button", { type: "button", class: "btn", text: "Choose from gallery" });
  take.addEventListener("click", () => camera.click());
  choose.addEventListener("click", () => gallery.click());
  const prevImg = h("img", { alt: "Preview of your selected photo" });
  const prev = h("div", { class: "photo-preview" }, prevImg);
  show(prev, false);
  const setFile = (file) => {
    if (!file) return;
    S.selfie = file;
    prevImg.src = URL.createObjectURL(file);
    show(prev, true);
    setMsg(err, "");
  };
  camera.addEventListener("change", () => setFile(camera.files[0]));
  gallery.addEventListener("change", () => setFile(gallery.files[0]));

  const consent = h("input", { type: "checkbox", id: "try-consent" });
  const err = h("div", { role: "alert" });
  const run = h("button", { type: "button", class: "btn btn-primary btn-lg", text: "Create my preview" });
  run.addEventListener("click", () => startTry(area, consent, err, run));

  S.selfie = null;
  S.hasResult = false;
  area.append(tip, h("div", { class: "btn-row" }, take, choose), camera, gallery, prev,
    h("div", { class: "check", style: "margin:16px 0" }, consent,
      h("label", { for: "try-consent", text: "I agree my photo is processed to create this preview and deleted automatically within 7 days." })),
    err, run);
  body.append(pickGrid, area);
  paintPicks();
  paintTip();
}

async function startTry(area, consent, err, runBtn) {
  if (!S.selfie) return setMsg(err, "Please take or choose a photo of yourself first.");
  if (!consent.checked) return setMsg(err, "Please tick the consent box to continue.");
  setMsg(err, "");
  const run = ++S.run;
  const selfie = S.selfie;
  const productId = S.tryProductId;
  const progress = createProgress();
  area.replaceChildren(progress.root);
  if (S.stopMessages) S.stopMessages();
  S.stopMessages = startProgressMessages(progress.msg);
  try {
    const form = new FormData();
    form.append("selfie", await shrinkImage(selfie));
    form.append("consent", "true");
    form.append("product_id", String(productId));
    const job = await runTryOn(S.slug, form, () => run !== S.run);
    if (!job || run !== S.run) return;
    S.stopMessages();
    S.hasResult = true;
    updateNav();
    const again = h("button", { type: "button", class: "btn", text: "Try another photo" });
    again.addEventListener("click", () => render());
    area.replaceChildren(
      createCompare(job.selfie_url, job.result_url),
      h("p", { class: "note", text: "AI preview — the actual piece may vary slightly." }),
      job.renderer === "mock" ? h("div", { class: "msg msg-info", text: "Demo mode: no AI model connected" }) : null,
      h("div", { class: "stack" }, again));
  } catch (e) {
    if (run !== S.run) return;
    S.stopMessages();
    const retry = h("button", { type: "button", class: "btn btn-primary", text: "Try again" });
    retry.addEventListener("click", () => render());
    area.replaceChildren(h("div", { class: "msg msg-error", role: "alert", text: e.message }), retry);
  }
}

// ---------- step 5: live ----------

function renderLiveStep(body) {
  const link = customerLink();
  const message = `Try our jewellery on yourself before you buy: ${link}`;
  body.append(
    h("h2", { class: "live-title", text: "You're live 🎉" }),
    h("p", { class: "lead live-title", text: "Share this with your customers. They can try on your pieces right from their phone." }));

  const linkInput = h("input", { type: "text", id: "live-link", readonly: true, value: link });
  linkInput.addEventListener("focus", () => linkInput.select());
  const copy = h("button", { type: "button", class: "btn", text: "Copy" });
  copy.addEventListener("click", () => copyText(link, copy));
  const open = h("a", { class: "btn", href: `/s/${encodeURIComponent(S.slug)}`, target: "_blank", rel: "noopener", text: "Open" });
  body.append(h("div", { class: "field" }, h("label", { for: "live-link", text: "Your customer link" }),
    h("div", { class: "link-box" }, linkInput, copy, open)));

  const qrUrl = `/api/stores/${encodeURIComponent(S.slug)}/qr.png`;
  body.append(h("div", { class: "qr-box" },
    h("img", { src: qrUrl, alt: "QR code for your customer link" }),
    h("a", { class: "btn btn-sm", href: qrUrl, download: `${S.slug}-qr.png`, text: "Download QR code" }),
    h("p", { class: "hint", text: "Print it for your shop counter or add it to packaging." })));

  const text = h("textarea", { id: "share-text", class: "share-text" });
  text.value = message;
  const copyMsg = h("button", { type: "button", class: "btn", text: "Copy message" });
  copyMsg.addEventListener("click", () => copyText(text.value, copyMsg));
  const wa = h("a", { class: "btn btn-wa", target: "_blank", rel: "noopener", text: "Share on WhatsApp" });
  const updateWa = () => { wa.href = `https://wa.me/?text=${encodeURIComponent(text.value)}`; };
  text.addEventListener("input", updateWa);
  updateWa();
  body.append(h("div", { class: "field", style: "margin-top:20px" },
    h("label", { for: "share-text", text: "Ready-to-paste message for WhatsApp or Instagram" }), text,
    h("div", { class: "btn-row" }, copyMsg, wa)));

  const dash = h("a", { class: "btn btn-primary", href: `/admin/${encodeURIComponent(S.slug)}`, text: "Go to dashboard" });
  const restart = h("button", { type: "button", class: "btn", text: "Start over" });
  restart.addEventListener("click", () => {
    if (confirm("Start over with a new store? Your current store stays online; just make sure you saved its admin key.")) startOver();
  });
  body.append(h("div", { class: "btn-row", style: "margin-top:20px" }, dash, restart));
}

// ---------- render ----------

const RENDERERS = [renderStoreStep, renderProductsStep, renderCatalogueStep, renderTryStep, renderLiveStep];

function render() {
  const done = new Set(Array.from({ length: S.step }, (_, i) => i));
  renderStepper($("stepper"), STEPS, S.step, done);
  const body = $("step-body");
  body.replaceChildren();
  RENDERERS[S.step](body);
  updateNav();
}

// ---------- init ----------

async function resume(slug, token, step, extra = {}) {
  S.slug = slug;
  S.token = token;
  const store = await call(`${base()}/admin/check`);
  S.categories = store.all_categories;
  S.storeName = store.name;
  S.websiteUrl = store.website_url || "";
  S.products = await api(`${base()}/products`);
  S.step = step;
  Object.assign(S, extra);
}

async function init() {
  $("btn-back").addEventListener("click", () => go(S.step - 1));
  $("btn-next").addEventListener("click", onNext);
  try {
    const cfg = await api("/api/signup/config");
    S.openSignup = cfg.open_signup;
    S.categories = cfg.categories;
  } catch (err) {
    setMsg($("global-error"), err.message);
  }

  const wanted = new URLSearchParams(location.search).get("store");
  const saved = load();
  try {
    if (wanted && storageGet(`tryon-admin-${wanted}`)) {
      await resume(wanted, storageGet(`tryon-admin-${wanted}`), 1, { ackKey: true });
    } else if (saved && saved.slug && saved.token) {
      await resume(saved.slug, saved.token, saved.step || 0, { ackKey: Boolean(saved.ackKey), later: Boolean(saved.later) });
    }
  } catch (err) {
    // Saved store is gone or the key no longer works: start fresh.
    storageSet(KEY, null);
    Object.assign(S, { slug: "", token: "", step: 0, products: [] });
  }
  render();
}

init();
