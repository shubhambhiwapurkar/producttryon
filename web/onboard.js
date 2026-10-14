/* Onboarding wizard: boutique details, collection, review, try-on, live. */
import {
  $, h, show, api, storageGet, storageSet, categoryLabel, formatPrice, slugify, copyText,
  shrinkImage, createCompare, createProgress, startProgressMessages, runTryOn, TIPS,
} from "/static/common.js";
import {
  icon, toast, confirmDialog, field, textInput, categorySelect, savedTick, downloadText,
  buildProductForm, buildImporter, buildSharePanel, customerLink, adminTokenKey, PLACEMENT,
} from "/static/studio-common.js";

const STEPS = 5;
const KEY = "tryon-onboard";
const pad = (n) => String(n).padStart(2, "0");

const S = {
  step: 0,
  slug: "",
  token: "",
  storeName: "",
  websiteUrl: "",
  ackKey: false,
  mode: "", // import | hand | later
  openSignup: true,
  categories: [],
  products: [],
  form: { name: "", wa: "", web: "", code: "" },
  tryProductId: null,
  selfie: null,
  run: 0,
  stopMessages: null,
  hasResult: false,
  busy: false,
};

const created = () => Boolean(S.slug && S.token);
const base = () => `/api/stores/${encodeURIComponent(S.slug)}`;

/** API call with the admin key. A rejected key restarts the wizard. */
async function call(path, options = {}) {
  try {
    return await api(path, { ...options, token: S.token });
  } catch (err) {
    if (err.unauthorized) {
      toast("Your studio key is no longer valid. Let's start afresh.", "error");
      resetState();
      render();
    }
    throw err;
  }
}

// ---------- persistence ----------

function save() {
  const { name, wa, web } = S.form;
  storageSet(KEY, JSON.stringify({
    slug: S.slug, token: S.token, step: S.step, ackKey: S.ackKey, mode: S.mode,
    tryProductId: S.tryProductId, form: { name, wa, web },
  }));
}

function load() {
  try { return JSON.parse(storageGet(KEY) || "null"); } catch (e) { return null; }
}

function resetState() {
  S.run++;
  if (S.stopMessages) S.stopMessages();
  storageSet(KEY, null);
  Object.assign(S, {
    step: 0, slug: "", token: "", storeName: "", websiteUrl: "", ackKey: false, mode: "", products: [],
    form: { name: "", wa: "", web: "", code: "" }, tryProductId: null, selfie: null, hasResult: false,
  });
}

// ---------- layout helpers ----------

const em = (text) => h("em", { class: "italic", text });

function head(n, titleParts, lede) {
  const title = h("h1", { class: "ob-title", tabindex: "-1" }, ...titleParts);
  return h("header", { class: "ob-head" },
    h("p", { class: "eyebrow", text: `Step ${pad(n)}` }), title, lede ? h("p", { class: "lede", text: lede }) : null);
}

function ornament() {
  const wrap = h("div", { class: "orn", "aria-hidden": "true" }, h("span"));
  wrap.append(icon("gem", 18), h("span"));
  return wrap;
}

function thumbOf(p) {
  const img = p.images && p.images[0];
  return img ? h("img", { src: img.url, alt: "", loading: "lazy" }) : null;
}

// ---------- navigation ----------

function isValid() {
  if (S.busy) return false;
  switch (S.step) {
    case 0: return created() ? S.ackKey : Boolean(S.form.name.trim()) && (S.openSignup || Boolean(S.form.code.trim()));
    case 1: return S.products.length >= 1 || S.mode === "later";
    default: return true;
  }
}

function updateNav() {
  const back = $("btn-back");
  const next = $("btn-next");
  back.style.visibility = S.step === 0 ? "hidden" : "visible";
  show(next, S.step < STEPS - 1);
  next.disabled = !isValid();
  let label = "Continue";
  if (S.step === 3 && !S.hasResult) label = "Skip for now";
  next.textContent = label;
  $("ob-nav").classList.toggle("is-single", S.step === STEPS - 1);
}

function paintBar() {
  $("ob-label").textContent = `Step ${pad(S.step + 1)} of ${pad(STEPS)}`;
  $("ob-fill").style.width = `${((S.step + 1) / STEPS) * 100}%`;
  const bar = $("ob-progress");
  bar.setAttribute("aria-valuenow", String(S.step + 1));
  bar.setAttribute("aria-valuetext", `Step ${S.step + 1} of ${STEPS}`);
}

let direction = "fwd";

async function go(step) {
  const target = Math.max(0, Math.min(STEPS - 1, step));
  direction = target >= S.step ? "fwd" : "back";
  const stage = $("stage");
  S.run++;
  if (S.stopMessages) S.stopMessages();
  stage.classList.add("is-leaving");
  await new Promise((r) => setTimeout(r, 180));
  S.step = target;
  save();
  render();
  window.scrollTo({ top: 0 });
}

async function onNext() {
  if (!isValid()) return;
  if (S.step === 0 && !created()) return createStore();
  go(S.step + 1);
}

// ---------- step 1: your boutique ----------

async function createStore() {
  const f = S.form;
  const payload = { name: f.name.trim() };
  if (f.wa.trim()) payload.whatsapp_number = f.wa.trim();
  if (f.web.trim()) payload.website_url = /^https?:\/\//i.test(f.web.trim()) ? f.web.trim() : `https://${f.web.trim()}`;
  if (!S.openSignup) payload.invite_code = f.code.trim();
  const next = $("btn-next");
  S.busy = true; next.classList.add("is-busy"); next.disabled = true;
  try {
    const store = await api("/api/signup", { method: "POST", json: payload });
    S.slug = store.slug;
    S.token = store.admin_token;
    S.storeName = store.name;
    S.websiteUrl = store.website_url || "";
    S.ackKey = false;
    storageSet(adminTokenKey(S.slug), S.token);
    S.busy = false;
    save();
    $("stage").classList.add("is-leaving");
    await new Promise((r) => setTimeout(r, 180));
    render();
  } catch (err) {
    S.busy = false;
    const msg = err.status === 403 ? "That invite code isn't valid. Please check it with the person who invited you."
      : err.status === 409 ? "That boutique link is already taken. Try a slightly different name." : err.message;
    showFormError(msg);
  } finally {
    next.classList.remove("is-busy");
    updateNav();
  }
}

function showFormError(text) {
  const box = $("form-error");
  if (!box) return toast(text, "error");
  box.textContent = text;
  box.className = "msg msg-error";
  box.hidden = false;
}

function stepBoutique(root) {
  if (created()) return stepKey(root);
  root.append(head(1, ["Your ", em("boutique")], "Tell us about your house. It takes a few minutes, and nothing here is final."));

  const preview = h("div", { class: "link-preview", "aria-live": "polite" });
  const paintPreview = () => {
    preview.replaceChildren(
      h("span", { class: "eyebrow", text: "Your customer link" }),
      h("p", { class: "link-text" }, `${location.host}/s/`, h("b", { text: slugify(S.form.name || "your-boutique") })));
  };
  const bind = (el, key) => {
    el.value = S.form[key];
    el.addEventListener("input", () => { S.form[key] = el.value; paintPreview(); updateNav(); });
    el.addEventListener("change", save);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onNext(); } });
    return el;
  };
  const name = bind(textInput("f-name", { required: true, maxlength: "200", placeholder: "e.g. Maison Sharma", autocomplete: "organization" }), "name");
  const form = h("div", { class: "ob-form" },
    field("Boutique name", name),
    preview,
    field("WhatsApp number", bind(textInput("f-wa", { type: "tel", inputmode: "tel", placeholder: "+91 98765 43210" }), "wa"),
      "Customers will enquire about pieces here."),
    field("Website (optional)", bind(textInput("f-web", { type: "url", inputmode: "url", placeholder: "yourwebsite.com" }), "web"),
      "We can bring your pieces across from it in the next step."));
  if (!S.openSignup) {
    form.append(field("Invite code", bind(textInput("f-code", { required: true, autocapitalize: "off" }), "code"),
      "Studios are opened by invitation. Enter the code you were given."));
  }
  form.append(h("div", { id: "form-error", hidden: true, role: "alert" }));
  root.append(form);
  paintPreview();
}

function stepKey(root) {
  root.append(head(1, ["Your boutique is ", em("created")], `${S.storeName || S.slug} now has its own address. One last thing before we go on.`));

  const copyBtn = h("button", { type: "button", class: "btn btn-sm", text: "Copy" }, );
  copyBtn.prepend(icon("copy", 14));
  copyBtn.addEventListener("click", () => { copyText(S.token, copyBtn); toast("Studio key copied"); });
  const file = h("button", { type: "button", class: "btn btn-sm btn-ghost" }, icon("download", 14), "Save as file");
  file.addEventListener("click", () => downloadText(`${S.slug}-studio-key.txt`,
    `${S.storeName || S.slug}\nStudio: ${location.origin}/admin/${S.slug}\nStudio key: ${S.token}\n`));

  const ack = h("input", { type: "checkbox", id: "ack-key" });
  ack.checked = S.ackKey;
  ack.addEventListener("change", () => { S.ackKey = ack.checked; save(); updateNav(); });

  root.append(
    h("div", { class: "keycard", role: "group", "aria-label": "Your studio key" },
      h("div", { class: "keycard-in" },
        h("p", { class: "eyebrow", text: "Your studio key" }),
        h("code", { class: "key", id: "studio-key", text: S.token }),
        h("p", { class: "small", text: "This key opens your studio, where you manage pieces and settings. Keep it somewhere safe; it is shown only here." }),
        h("div", { class: "keycard-actions" }, copyBtn, file))),
    h("label", { class: "check ob-ack", for: "ack-key" }, ack, "I've saved my key in a safe place"));
}

// ---------- step 2: your collection ----------

async function refreshProducts() {
  try { S.products = await api(`${base()}/products`); } catch (err) { toast(err.message, "error"); }
  paintCollection();
  updateNav();
}

const OPTIONS = [
  ["import", "globe", "Import from my website", "Shopify, WooCommerce or any product page"],
  ["hand", "gem", "Add pieces by hand", "Photograph and describe each piece"],
  ["later", "clock", "I'll do this later", "Your boutique stays open to customers' own pieces"],
];

function stepCollection(root) {
  root.append(head(2, ["Your ", em("collection")], "Bring your pieces across. Use either way, or both. You can always add more from your studio."));

  const grid = h("div", { class: "choices", role: "group", "aria-label": "How would you like to add your pieces?" });
  const panel = h("div", { class: "choice-panel", id: "choice-panel" });
  const paint = (animate) => {
    grid.replaceChildren();
    for (const [key, ic, title, sub] of OPTIONS) {
      const b = h("button", { type: "button", class: "choice", "aria-pressed": String(S.mode === key) },
        icon(ic, 28), h("span", { class: "choice-text" }, h("strong", { text: title }), h("span", { text: sub })));
      b.addEventListener("click", () => { S.mode = S.mode === key ? "" : key; save(); paint(true); updateNav(); });
      grid.append(b);
    }
    panel.replaceChildren();
    if (S.mode === "import") panel.append(h("div", { class: `panel${animate ? " fade-in" : ""}` }, buildImporter({
      call, base: base(), defaultUrl: S.websiteUrl || S.form.web.trim() || "", onDone: refreshProducts,
    })));
    if (S.mode === "hand") panel.append(h("div", { class: `panel${animate ? " fade-in" : ""}` }, buildProductForm({
      categories: S.categories, create: (fd) => call(`${base()}/products`, { method: "POST", body: fd }), onAdded: refreshProducts,
    })));
    if (S.mode === "later") panel.append(h("p", { class: `panel panel-note${animate ? " fade-in" : ""}`, text: "Of course. Your studio will remind you when you are ready to add pieces." }));
  };
  root.append(grid, panel, h("div", { id: "collection-strip" }));
  paint(false);
  paintCollection();
  refreshProducts();
}

function paintCollection() {
  const host = $("collection-strip");
  if (!host) return;
  host.replaceChildren();
  const n = S.products.length;
  if (!n) return;
  const strip = h("div", { class: "strip" });
  for (const p of S.products) strip.append(h("div", { class: "strip-item", title: p.name }, h("div", { class: "well" }, thumbOf(p))));
  host.append(h("div", { class: "collection fade-in" },
    h("div", { class: "collection-head" },
      h("span", { class: "eyebrow", text: "In your collection" }),
      h("span", { class: "small", text: `${n} piece${n === 1 ? "" : "s"}` })),
    strip));
}

// ---------- step 3: review your pieces ----------

function stepReview(root) {
  root.append(head(3, ["Review your ", em("pieces")], "Check the details. The type decides where a piece is placed on your customer: a necklace at the neck, earrings at the ears, a ring on the finger."));
  if (!S.products.length) {
    root.append(h("div", { class: "empty" }, h("p", { class: "display-sm", text: "No pieces yet" }),
      h("p", { class: "small", text: "Go back to add some, or continue and add them later from your studio." })));
    return;
  }
  const grid = h("div", { class: "review-grid" });
  for (const p of S.products) grid.append(reviewCard(p));
  root.append(grid);
  api(`${base()}/products`).then((list) => { S.products = list; }).catch(() => {});
}

function reviewCard(p) {
  const tick = savedTick();
  const name = textInput(`ed-name-${p.id}`, { maxlength: "300", "aria-label": `Name of ${p.name}` });
  name.value = p.name;
  const cat = categorySelect(`ed-cat-${p.id}`, S.categories, p.category);
  cat.setAttribute("aria-label", `Type of ${p.name}`);
  const price = textInput(`ed-price-${p.id}`, { inputmode: "decimal", placeholder: "Price", "aria-label": `Price of ${p.name}` });
  price.value = p.price || "";
  const where = h("span", { class: "small where" });
  const paintWhere = () => { where.textContent = `Placed on the ${PLACEMENT[cat.value] || "body"}`; };
  paintWhere();

  const patch = async (fieldName, value, el) => {
    if (fieldName === "name" && !value) { el.value = p.name; return; }
    if (String(p[fieldName] ?? "") === value) return;
    try {
      Object.assign(p, await call(`${base()}/products/${p.id}`, { method: "PATCH", json: { [fieldName]: value } }));
      tick.flash();
    } catch (e) {
      el.value = p[fieldName] ?? "";
      paintWhere();
      toast(e.message, "error");
    }
  };
  name.addEventListener("change", () => patch("name", name.value.trim(), name));
  cat.addEventListener("change", () => { paintWhere(); patch("category", cat.value, cat); });
  price.addEventListener("change", () => patch("price", price.value.trim(), price));

  const del = h("button", { type: "button", class: "icon-btn", "aria-label": `Delete ${p.name}` }, icon("trash", 16));
  del.addEventListener("click", async () => {
    if (!await confirmDialog({ title: "Remove this piece?", body: `${p.name} will be removed from your collection.`, confirmLabel: "Remove", danger: true })) return;
    try {
      await call(`${base()}/products/${p.id}`, { method: "DELETE" });
      S.products = S.products.filter((x) => x.id !== p.id);
      card.remove();
      if (!S.products.length) render();
      toast("Piece removed");
    } catch (e) { toast(e.message, "error"); }
  });

  const card = h("article", { class: "review-card" },
    h("div", { class: "well" }, thumbOf(p), del),
    h("div", { class: "review-fields" }, name, cat, price,
      h("div", { class: "review-foot" }, where, tick.el)));
  return card;
}

// ---------- step 4: try it yourself ----------

function stepTry(root) {
  root.append(head(4, ["Try it ", em("yourself")], "See what your customers will see. Choose a piece, add a photo of yourself, and watch it appear. You can skip this."));
  if (!S.products.length) {
    root.append(h("div", { class: "empty" }, h("p", { class: "display-sm", text: "Nothing to try yet" }),
      h("p", { class: "small", text: "Add a piece first, or skip this step." })));
    return;
  }
  if (!S.products.some((p) => p.id === S.tryProductId)) S.tryProductId = S.products[0].id;
  S.selfie = null;
  S.hasResult = false;

  const picks = h("div", { class: "picks", role: "group", "aria-label": "Choose a piece" });
  const area = h("div", { class: "try-area", id: "try-area" });
  const paintPicks = () => {
    picks.replaceChildren();
    for (const p of S.products) {
      const b = h("button", { type: "button", class: "pick", "aria-pressed": String(p.id === S.tryProductId), title: p.name },
        h("div", { class: "well" }, thumbOf(p)), h("span", { text: p.name }));
      b.addEventListener("click", () => { S.tryProductId = p.id; save(); paintPicks(); paintTip(); });
      picks.append(b);
    }
  };
  const tip = h("p", { class: "tip" });
  const paintTip = () => {
    const p = S.products.find((x) => x.id === S.tryProductId);
    tip.replaceChildren(h("b", { text: "For the best result: " }), TIPS[p ? p.category : "other"] || TIPS.other);
  };

  root.append(h("p", { class: "label", text: "1. Choose a piece" }), picks, h("p", { class: "label step-label", text: "2. Your photograph" }), area);
  paintPicks();
  uploadView(area, paintTip, tip);
}

function uploadView(area, paintTip, tip) {
  area.replaceChildren();
  const input = h("input", { type: "file", accept: "image/*", hidden: true, id: "try-file" });
  const camera = h("input", { type: "file", accept: "image/*", capture: "user", hidden: true, id: "try-camera" });
  const drop = h("button", { type: "button", class: "dropzone", "aria-label": "Choose a photograph" },
    icon("camera", 30), h("strong", { text: "Add a photograph" }), h("span", { class: "small", text: "Choose from your device, or take a selfie" }));
  const preview = h("div", { class: "selfie-preview", hidden: true });
  const consent = h("input", { type: "checkbox", id: "try-consent" });
  const err = h("div", { role: "alert", hidden: true });
  const run = h("button", { type: "button", class: "btn btn-primary", text: "Create my preview" });
  const take = h("button", { type: "button", class: "btn btn-sm btn-ghost", text: "Take a selfie" });
  take.prepend(icon("camera", 14));

  const setFile = (file) => {
    if (!file) return;
    S.selfie = file;
    preview.replaceChildren(h("img", { src: URL.createObjectURL(file), alt: "Your photograph" }));
    const change = h("button", { type: "button", class: "btn btn-sm btn-ghost", text: "Choose another" });
    change.addEventListener("click", () => input.click());
    preview.append(change);
    preview.hidden = false; drop.hidden = true; take.hidden = true;
    err.hidden = true;
  };
  drop.addEventListener("click", () => input.click());
  take.addEventListener("click", () => camera.click());
  input.addEventListener("change", () => setFile(input.files[0]));
  camera.addEventListener("change", () => setFile(camera.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("is-drop"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-drop"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("is-drop"); setFile(e.dataTransfer.files[0]); });

  const fail = (text) => { err.textContent = text; err.className = "msg msg-error"; err.hidden = false; };
  run.addEventListener("click", () => {
    if (!S.selfie) return fail("Please add a photograph of yourself first.");
    if (!consent.checked) return fail("Please tick the consent box to continue.");
    startTry(area);
  });
  area.append(tip, drop, preview, h("div", { class: "try-actions" }, take), input, camera,
    h("label", { class: "check ob-ack", for: "try-consent" }, consent, "I agree my photograph is processed to create this preview and deleted automatically within 7 days."),
    err, h("div", { class: "form-actions" }, run));
  paintTip();
}

async function startTry(area) {
  const run = ++S.run;
  const selfie = S.selfie;
  const productId = S.tryProductId;
  const progress = createProgress();
  area.replaceChildren(progress.root);
  if (S.stopMessages) S.stopMessages();
  S.stopMessages = startProgressMessages(progress.msg);
  const failView = (message) => {
    const retry = h("button", { type: "button", class: "btn", text: "Try again" });
    retry.addEventListener("click", () => render({ keepAnimation: true }));
    area.replaceChildren(h("div", { class: "msg msg-error", role: "alert", text: message }), h("div", { class: "form-actions" }, retry));
  };
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
    const again = h("button", { type: "button", class: "btn btn-sm btn-ghost", text: "Try another photograph" });
    again.addEventListener("click", () => render({ keepAnimation: true }));
    area.replaceChildren(h("div", { class: "result fade-in" },
      createCompare(job.selfie_url, job.result_url),
      h("p", { class: "small center", text: "AI preview. The finished piece may differ slightly." }),
      job.renderer === "mock" ? h("p", { class: "small center", text: "Demo mode: no AI model is connected, so this is a placeholder preview." }) : null,
      h("div", { class: "center" }, again)));
  } catch (e) {
    if (run === S.run) { S.stopMessages(); failView(e.message); }
  }
}

// ---------- step 5: live ----------

function stepLive(root) {
  const title = h("h1", { class: "ob-title display", tabindex: "-1" }, "Your boutique is ", em("live"));
  root.append(h("header", { class: "ob-head center live-head" },
    ornament(),
    h("p", { class: "eyebrow", text: "Step 05" }),
    title,
    h("p", { class: "lede", text: `${S.storeName || "Your boutique"} is open. Share the link and customers can try your jewellery on from their phone.` })));

  root.append(buildSharePanel({ slug: S.slug, idPrefix: "live" }));

  const studio = h("a", { class: "btn btn-primary", href: `/admin/${encodeURIComponent(S.slug)}`, text: "Open my studio" });
  const restart = h("button", { type: "button", class: "btn btn-ghost", text: "Start over" });
  restart.addEventListener("click", async () => {
    if (await confirmDialog({
      title: "Start over?", confirmLabel: "Start over", danger: true,
      body: "Your current boutique stays online. Make sure you have saved its studio key before beginning a new one.",
    })) { resetState(); render(); }
  });
  root.append(h("div", { class: "live-actions" }, studio, restart));
}

// ---------- render ----------

const RENDERERS = [stepBoutique, stepCollection, stepReview, stepTry, stepLive];
const WIDE = new Set([2]);

function render() {
  const stage = $("stage");
  stage.replaceChildren();
  stage.className = `ob-stage step-in-${direction}`;
  $("ob-col").classList.toggle("is-wide", WIDE.has(S.step));
  RENDERERS[S.step](stage);
  paintBar();
  updateNav();
  const heading = stage.querySelector(".ob-title");
  if (heading) heading.focus({ preventScroll: true });
}

// ---------- init ----------

async function resume(slug, token, extra = {}) {
  S.slug = slug;
  S.token = token;
  const store = await api(`/api/stores/${encodeURIComponent(slug)}/admin/check`, { token });
  S.storeName = store.name;
  S.websiteUrl = store.website_url || "";
  if (store.all_categories) S.categories = store.all_categories;
  S.products = await api(`/api/stores/${encodeURIComponent(slug)}/products`);
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
    toast(err.message, "error");
  }

  const wanted = new URLSearchParams(location.search).get("store");
  const saved = load();
  try {
    const wantedToken = wanted && storageGet(adminTokenKey(wanted));
    if (wantedToken) {
      await resume(wanted, wantedToken, { step: 1, ackKey: true, mode: "" });
    } else if (saved && saved.slug && saved.token) {
      await resume(saved.slug, saved.token, {
        step: Math.min(STEPS - 1, saved.step || 0), ackKey: Boolean(saved.ackKey), mode: saved.mode || "", tryProductId: saved.tryProductId || null,
      });
    } else if (saved && saved.form) {
      Object.assign(S.form, saved.form);
    }
  } catch (err) {
    storageSet(KEY, null);
    Object.assign(S, { slug: "", token: "", step: 0, products: [], ackKey: false });
  }
  direction = "fwd";
  render();
}

init();
