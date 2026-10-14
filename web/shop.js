/* Customer storefront: browse the collection, try a piece on, compare before/after. */
import {
  $, h, show, setMsg, api, slugFromPath, categoryLabel, formatPrice, debounce, shrinkImage, TIPS,
  whatsappDigits, createCompare, runTryOn, renderStepper,
} from "/static/common.js";

const slug = slugFromPath();

const state = {
  store: null,
  products: [],
  loaded: false,
  category: "",
  query: "",
  product: null, // product being tried, or null for "own piece"
  ownFiles: [],
  selfie: null,
  view: "detail",
  run: 0, // increments to cancel in-flight polling
  lastFocus: null,
  stopMessages: null,
  asideUrl: null,
};

// ---------- small helpers ----------

const WA_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.04 2a9.9 9.9 0 0 0-8.4 15.1L2 22l5.05-1.6A9.9 9.9 0 1 0 12.04 2zm0 1.8a8.1 8.1 0 1 1-4.3 15l-.3-.18-2.9.92.94-2.82-.2-.3A8.1 8.1 0 0 1 12.04 3.8zm-3 3.9c-.2 0-.5.07-.75.35-.25.27-.97.95-.97 2.3s1 2.7 1.12 2.88c.14.18 1.9 3.02 4.7 4.1 2.3.9 2.8.72 3.3.68.5-.05 1.6-.65 1.82-1.28.23-.63.23-1.17.16-1.28-.07-.12-.25-.18-.52-.32-.27-.13-1.6-.8-1.85-.88-.25-.1-.43-.14-.6.13-.18.27-.7.88-.86 1.06-.16.18-.32.2-.6.07-.27-.14-1.14-.42-2.17-1.34-.8-.72-1.34-1.6-1.5-1.87-.16-.27-.02-.42.12-.55.12-.12.27-.32.4-.48.14-.16.18-.27.27-.45.1-.18.05-.34-.02-.48-.07-.13-.6-1.46-.83-2-.2-.5-.43-.43-.6-.44h-.5z"/></svg>';

function icon(markup) {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

const waUrl = (text) => {
  const digits = whatsappDigits(state.store && state.store.whatsapp_number);
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : "";
};
const pageUrl = () => `${location.origin}${location.pathname}`;

function showError(text) { setMsg($("page-error"), text); }

// ---------- store + collection ----------

async function loadStore() {
  try {
    state.store = await api(`/api/stores/${encodeURIComponent(slug)}`);
  } catch (err) {
    $("store-name").textContent = "Store not found";
    $("foot-name").textContent = "";
    ["hero", "collection", "own"].forEach((id) => show($(id), false));
    document.querySelector(".how").hidden = true;
    $("nav-own").hidden = true;
    $("nav-collection").hidden = true;
    showError(err.message);
    return false;
  }
  const name = state.store.name;
  document.title = `${name} – Virtual Try-On`;
  $("store-name").textContent = name;
  $("store-name").setAttribute("aria-label", `${name}, back to top`);
  $("foot-name").textContent = name;

  const wa = waUrl("Hi! I'd like to know more about your jewellery.");
  if (wa) {
    $("announce-wa").href = wa;
    $("foot-wa").href = wa;
    show($("announce-wa-wrap"), true);
    show($("foot-wa"), true);
  }
  const site = state.store.website_url || "";
  if (/^https?:\/\//i.test(site)) { $("foot-site").href = site; show($("foot-site"), true); }

  fillCategorySelect();
  return true;
}

function fillCategorySelect() {
  const sel = $("own-category");
  sel.replaceChildren(h("option", { value: "", text: "Choose a type…" }));
  for (const cat of state.store.all_categories) sel.append(h("option", { value: cat, text: categoryLabel(cat) }));
}

function renderSkeleton() {
  const grid = $("grid");
  grid.setAttribute("aria-busy", "true");
  grid.replaceChildren(...Array.from({ length: 8 }, () =>
    h("div", { class: "pcard is-skeleton", "aria-hidden": "true" },
      h("div", { class: "pcard-media" }),
      h("div", { class: "pcard-info" }, h("span", { class: "sk sk-s" }), h("span", { class: "sk sk-m" }), h("span", { class: "sk sk-s" })))));
}

async function loadProducts() {
  renderSkeleton();
  try {
    state.products = await api(`/api/stores/${encodeURIComponent(slug)}/products`);
  } catch (err) {
    showError(err.message);
    state.products = [];
  }
  state.loaded = true;
  renderHero();
  renderTabs();
  renderGrid();
}

function visibleProducts() {
  const q = state.query.toLowerCase();
  return state.products.filter((p) =>
    (!state.category || p.category === state.category) &&
    (!q || p.name.toLowerCase().includes(q) || categoryLabel(p.category).toLowerCase().includes(q)));
}

function renderTabs() {
  const nav = $("cat-tabs");
  nav.replaceChildren();
  const cats = Object.entries(state.store.categories).filter(([, n]) => n > 0);
  if (cats.length <= 1) { show(nav, false); return; }
  show(nav, true);
  const total = cats.reduce((a, [, n]) => a + n, 0);
  const make = (value, label, count) => {
    const b = h("button", { type: "button", class: "cat-tab", "aria-pressed": String(state.category === value) },
      label, h("sup", { text: String(count) }));
    b.addEventListener("click", () => { state.category = value; renderTabs(); renderGrid(); });
    return b;
  };
  nav.append(make("", "All", total));
  for (const [cat, n] of cats) nav.append(make(cat, categoryLabel(cat), n));
}

function gemPlaceholder() {
  return icon('<svg class="gem-line" viewBox="0 0 56 56" fill="none" stroke="currentColor" stroke-width="0.8" stroke-linejoin="round" aria-hidden="true"><path d="M16 8h24l10 12-22 28L6 20z"/><path d="M6 20h44M20 20l8 28 8-28M16 8l4 12 8-12 8 12 4-12"/></svg>');
}

function renderGrid() {
  const grid = $("grid");
  grid.setAttribute("aria-busy", "false");
  grid.replaceChildren();
  const products = visibleProducts();
  const empty = $("empty");
  show(empty, products.length === 0);
  if (products.length === 0) {
    const none = state.products.length === 0;
    $("empty-title").textContent = none ? "The collection is being curated" : "No pieces found";
    $("empty-text").textContent = none
      ? "New pieces will appear here soon. In the meantime, see how a piece of your own looks on you."
      : "Try a different search, or browse the whole collection.";
    const action = $("empty-action");
    action.textContent = none ? "Try your own piece" : "View all pieces";
    action.dataset.mode = none ? "own" : "reset";
  }
  products.forEach((p, i) => {
    const img = p.images[0];
    const price = formatPrice(p);
    const open = h("button", { type: "button", class: "pcard-open" },
      h("span", { class: "pcard-media" }, img ? h("img", { src: img.url, alt: p.name, loading: "lazy", decoding: "async" }) : gemPlaceholder()),
      h("span", { class: "pcard-info" },
        h("span", { class: "eyebrow", text: categoryLabel(p.category) }),
        h("span", { class: "pcard-name", text: p.name }),
        price ? h("span", { class: "pcard-price", text: price }) : null));
    open.addEventListener("click", () => openProduct(p));
    const tryBtn = h("button", { type: "button", class: "pcard-try", "aria-label": `Try on ${p.name}`, text: "Try it on" });
    tryBtn.addEventListener("click", () => openProduct(p, { tryNow: true }));
    grid.append(h("article", { class: "pcard fade-in", style: `animation-delay:${Math.min(i, 8) * 50}ms` }, open, tryBtn));
  });
  $("grid-status").textContent = `${products.length} piece${products.length === 1 ? "" : "s"} shown`;
}

// ---------- hero collage ----------

function renderHero() {
  const wrap = $("hero-visual");
  wrap.replaceChildren();
  const withImg = state.products.filter((p) => p.images.length);
  const picks = [];
  const seen = new Set();
  for (const p of withImg) if (!seen.has(p.category) && picks.length < 3) { picks.push(p); seen.add(p.category); }
  for (const p of withImg) if (picks.length < 3 && !picks.includes(p)) picks.push(p);
  wrap.dataset.count = String(picks.length);
  if (picks.length === 0) {
    wrap.append(h("div", { class: "hv hv-a hv-empty", "aria-hidden": "true" }, gemPlaceholder()));
    return;
  }
  picks.forEach((p, i) => {
    const b = h("button", { type: "button", class: `hv hv-${"abc"[i]}`, "aria-label": `View ${p.name}` },
      h("img", { src: p.images[0].url, alt: "", loading: i === 0 ? "eager" : "lazy" }));
    b.addEventListener("click", () => openProduct(p));
    wrap.append(b);
  });
}

// ---------- panel ----------

const VIEWS = ["detail", "selfie", "progress", "result", "failed"];
// Which wizard step (0-based) each view belongs to.
const VIEW_STEP = { detail: 0, selfie: 1, progress: 1, failed: 1, result: 2 };
const panel = $("panel");

function renderTryStepper(view) {
  const labels = state.product
    ? ["Choose a piece", "Your photo", "Your look"]
    : ["Your piece", "Your photo", "Your look"];
  const step = VIEW_STEP[view];
  renderStepper($("try-stepper"), labels, step, new Set(Array.from({ length: step }, (_, i) => i)), { compact: true });
}

function setAside(view) {
  const main = $("gallery-main");
  const cap = $("aside-cap");
  if (state.asideUrl) { URL.revokeObjectURL(state.asideUrl); state.asideUrl = null; }
  if (!state.product) {
    if (state.ownFiles[0]) {
      state.asideUrl = URL.createObjectURL(state.ownFiles[0]);
      main.src = state.asideUrl;
      main.alt = "Your piece";
    }
  }
  const detail = view === "detail";
  show($("gallery-thumbs"), detail && Boolean(state.product) && state.product.images.length > 1);
  if (detail) { cap.textContent = ""; show(cap, false); return; }
  cap.textContent = state.product ? state.product.name : "Your piece";
  show(cap, true);
}

function showView(name, label) {
  state.view = name;
  panel.dataset.view = name;
  VIEWS.forEach((v) => show($(`view-${v}`), v === name));
  if (label) panel.setAttribute("aria-label", label);
  renderTryStepper(name);
  setAside(name);
  $("panel-main").scrollTop = 0;
  panel.scrollTop = 0;
}

function pageParts() { return document.querySelectorAll("[data-page]"); }

function openPanel() {
  state.lastFocus = document.activeElement;
  show($("overlay"), true);
  document.body.classList.add("no-scroll");
  pageParts().forEach((el) => { el.inert = true; });
}

function closePanel() {
  state.run++; // cancels polling
  stopMessages();
  show($("overlay"), false);
  document.body.classList.remove("no-scroll");
  pageParts().forEach((el) => { el.inert = false; });
  if (state.asideUrl) { URL.revokeObjectURL(state.asideUrl); state.asideUrl = null; }
  const f = state.lastFocus;
  if (f && f.isConnected && f.focus) f.focus({ preventScroll: true });
}

function focusPanel() { $("panel-close").focus({ preventScroll: true }); }

function trapTab(e) {
  if (e.key !== "Tab" || $("overlay").hidden) return;
  const focusable = Array.from(panel.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="slider"], [tabindex]:not([tabindex="-1"])'))
    .filter((el) => el.getClientRects().length > 0);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// ---------- product detail ----------

function openProduct(product, { tryNow = false } = {}) {
  state.product = product;
  openPanel();
  showView("detail", product.name);
  renderGallery(product);
  $("detail-cat").textContent = categoryLabel(product.category);
  $("detail-name").textContent = product.name;
  const price = formatPrice(product);
  $("detail-price").textContent = price;
  show($("detail-price"), Boolean(price));
  const desc = $("detail-desc");
  desc.textContent = product.description || "";
  show(desc, Boolean(product.description));
  const meta = $("detail-meta");
  meta.replaceChildren();
  const rows = [["Category", categoryLabel(product.category)], ["Dimensions", product.dimensions]];
  for (const [label, value] of rows) {
    if (value) meta.append(h("div", {}, h("dt", { text: label }), h("dd", { text: value })));
  }
  const link = $("detail-link");
  const safeUrl = /^https?:\/\//i.test(product.product_url || "") ? product.product_url : "";
  if (safeUrl) link.href = safeUrl;
  show(link, Boolean(safeUrl));
  const wa = waUrl(`Hi! I'm interested in ${product.name} (${pageUrl()}).`);
  const waBtn = $("detail-wa");
  waBtn.replaceChildren(icon(WA_ICON), "Enquire on WhatsApp");
  if (wa) waBtn.href = wa;
  show(waBtn, Boolean(wa));
  if (tryNow) openSelfieStep(); else focusPanel();
}

function renderGallery(product) {
  const main = $("gallery-main");
  const thumbs = $("gallery-thumbs");
  thumbs.replaceChildren();
  const images = product.images;
  const setMain = (img, btn) => {
    main.src = img.url;
    main.alt = `${product.name}${img.angle ? ", " + img.angle + " view" : ""}`;
    thumbs.querySelectorAll("button").forEach((b) => b.removeAttribute("aria-current"));
    if (btn) btn.setAttribute("aria-current", "true");
  };
  if (images.length === 0) { main.removeAttribute("src"); main.alt = ""; return; }
  images.forEach((img, i) => {
    const btn = h("button", { type: "button", "aria-label": `Show photo ${i + 1}${img.angle ? ", " + img.angle : ""}` },
      h("img", { src: img.url, alt: "" }));
    btn.addEventListener("click", () => setMain(img, btn));
    thumbs.append(btn);
  });
  setMain(images[0], thumbs.firstChild);
}

// ---------- pose guides (thin line art) ----------

const GUIDES = {
  bust: '<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="60" cy="36" rx="17" ry="21"/><path d="M52 56v14M68 56v14M52 70C36 74 22 80 15 100M68 70c16 4 30 10 37 30"/><path d="M42 78q18 24 36 0" stroke-dasharray="1.5 3.5"/><path d="M60 93l4.5 5.5L60 106l-4.5-7.5z" stroke-dasharray="0"/></svg>',
  head: '<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="60" cy="52" rx="21" ry="29"/><path d="M39 46c-8-3-9 13-1 14M81 46c8-3 9 13 1 14"/><path d="M36 64v7M84 64v7" stroke-dasharray="1.5 3.5"/><circle cx="36" cy="75" r="3"/><circle cx="84" cy="75" r="3"/><path d="M51 80v12M69 80v12M51 92C35 96 23 102 17 118M69 92c16 4 28 10 34 26"/></svg>',
  hand: '<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M40 114V68q0-6 6-6h30q6 0 6 6v46"/><path d="M46 62V30a5 5 0 0 1 10 0v32M56 62V20a5 5 0 0 1 10 0v42M66 62V26a5 5 0 0 1 10 0v36M76 62V36a5 5 0 0 1 10 0v26"/><path d="M40 86L24 68a5 5 0 0 1 8-6l12 12"/><ellipse cx="71" cy="46" rx="5.6" ry="2.6"/><path d="M38 100q25 7 50 0" stroke-dasharray="1.5 3.5"/></svg>',
  frame: '<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M18 40V20h20M82 20h20v20M102 80v20H82M38 100H18V80"/><circle cx="60" cy="60" r="14"/></svg>',
};
const GUIDE_FOR = {
  necklace: "bust", pendant: "bust", earrings: "head", maang_tikka: "head", nose_pin: "head",
  ring: "hand", bracelet: "hand", bangle: "hand",
};

// ---------- photo step ----------

function currentCategory() {
  return state.product ? state.product.category : $("own-category").value;
}

function openSelfieStep() {
  const cat = currentCategory();
  $("selfie-tip").textContent = TIPS[cat] || TIPS.other;
  $("guide-art").replaceChildren(icon(GUIDES[GUIDE_FOR[cat] || "frame"]));
  clearSelfie();
  $("consent").checked = false;
  setMsg($("selfie-error"), "");
  const label = state.product ? `Try on ${state.product.name}` : `Try on your ${categoryLabel(cat).toLowerCase()}`;
  showView("selfie", label);
  focusPanel();
}

function clearSelfie() {
  state.selfie = null;
  $("selfie-camera").value = "";
  $("selfie-gallery").value = "";
  const prev = $("selfie-img").src;
  if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
  $("selfie-img").removeAttribute("src");
  show($("selfie-preview"), false);
  show($("drop-empty"), true);
  $("selfie-drop").classList.remove("has-photo");
}

function setSelfie(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) return setMsg($("selfie-error"), "Please choose an image file.");
  clearSelfie();
  state.selfie = file;
  $("selfie-img").src = URL.createObjectURL(file);
  show($("selfie-preview"), true);
  show($("drop-empty"), false);
  $("selfie-drop").classList.add("has-photo");
  setMsg($("selfie-error"), "");
}

function wireDrop(zone, onFiles) {
  zone.addEventListener("dragenter", (e) => { e.preventDefault(); zone.classList.add("is-drag"); });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-drag"); });
  zone.addEventListener("dragleave", (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove("is-drag"); });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("is-drag");
    if (e.dataTransfer && e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files));
  });
}

// ---------- submit + poll ----------

const WAIT_MESSAGES = ["Selecting the light…", "Setting the stones…", "Polishing the details…", "Almost ready…"];

function startMessages(el) {
  let i = 0;
  const set = () => {
    el.classList.remove("swap");
    void el.offsetWidth; // restart the fade
    el.textContent = WAIT_MESSAGES[i];
    el.classList.add("swap");
  };
  set();
  const timer = setInterval(() => { i = Math.min(i + 1, WAIT_MESSAGES.length - 1); set(); }, 4500);
  return () => clearInterval(timer);
}

function stopMessages() {
  if (state.stopMessages) state.stopMessages();
  state.stopMessages = null;
}

async function submitTryOn() {
  const errBox = $("selfie-error");
  if (!state.selfie) return setMsg(errBox, "Please take or choose a photo of yourself first.");
  if (!$("consent").checked) return setMsg(errBox, "Please tick the consent box to continue.");
  setMsg(errBox, "");

  const run = ++state.run;
  $("progress-img").src = $("selfie-img").src;
  showView("progress", "Creating your look");
  stopMessages();
  state.stopMessages = startMessages($("progress-msg"));
  focusPanel();

  try {
    const form = new FormData();
    form.append("selfie", await shrinkImage(state.selfie));
    form.append("consent", "true");
    if (state.product) {
      form.append("product_id", String(state.product.id));
    } else {
      form.append("category", currentCategory());
      for (const f of state.ownFiles) form.append("product_images", await shrinkImage(f));
    }
    const job = await runTryOn(slug, form, () => run !== state.run);
    if (job && run === state.run) showResult(job);
  } catch (err) {
    if (run === state.run) fail(err.message);
  }
}

function fail(message) {
  stopMessages();
  $("failed-msg").textContent = message || "We couldn't create this preview. Please try another photo.";
  showView("failed", "Something went wrong");
  focusPanel();
}

// ---------- result ----------

function showResult(job) {
  stopMessages();
  const compare = createCompare(job.selfie_url, job.result_url);
  const handle = compare.querySelector(".handle");
  if (handle) handle.textContent = "‹ ›";
  const after = compare.querySelector(":scope > img");
  const fit = () => { if (after.naturalWidth) compare.style.setProperty("--ar", `${after.naturalWidth} / ${after.naturalHeight}`); };
  if (after.complete) fit(); else after.addEventListener("load", fit);
  $("compare-slot").replaceChildren(compare);

  const dl = $("result-download");
  dl.href = job.result_url;
  dl.setAttribute("download", `${slug}-tryon.jpg`);
  const wa = waUrl(state.product
    ? `Hi! I tried on ${state.product.name} (${pageUrl()}) and would like to know more.`
    : `Hi! I tried on a piece of jewellery using your virtual try-on (${pageUrl()}) and would like to know more.`);
  const waBtn = $("result-wa");
  waBtn.replaceChildren(icon(WA_ICON), "Enquire on WhatsApp");
  if (wa) waBtn.href = wa;
  show(waBtn, Boolean(wa));
  show($("demo-note"), job.renderer === "mock");
  showView("result", "Your look");
  focusPanel();
}

// ---------- own piece ----------

function renderOwnStepper() {
  renderStepper($("own-stepper"), ["Your piece", "Your photo", "Your look"], 0, new Set(), { compact: true });
}

function renderOwnThumbs() {
  const list = $("own-thumbs");
  list.querySelectorAll("img").forEach((i) => URL.revokeObjectURL(i.src));
  list.replaceChildren();
  state.ownFiles.forEach((file, i) => {
    const remove = h("button", { type: "button", class: "thumb-remove", "aria-label": `Remove photo ${i + 1}` });
    remove.append(icon('<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9"/></svg>'));
    remove.addEventListener("click", () => { state.ownFiles.splice(i, 1); renderOwnThumbs(); });
    list.append(h("li", {}, h("img", { src: URL.createObjectURL(file), alt: `Your piece, photo ${i + 1}` }), remove));
  });
  show(list, state.ownFiles.length > 0);
  $("own-add").disabled = state.ownFiles.length >= 4;
  $("own-drop").classList.toggle("is-full", state.ownFiles.length >= 4);
}

function addOwnFiles(fileList) {
  const err = $("own-error");
  setMsg(err, "");
  const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
  const room = 4 - state.ownFiles.length;
  if (files.length > room) setMsg(err, "You can add up to 4 photos. Extra photos were ignored.");
  state.ownFiles.push(...files.slice(0, room));
  $("own-files").value = "";
  renderOwnThumbs();
}

function startOwnFlow() {
  const err = $("own-error");
  if (state.ownFiles.length === 0) return setMsg(err, "Please add at least one photo of the piece.");
  if (!$("own-category").value) return setMsg(err, "Please choose the type of jewellery.");
  setMsg(err, "");
  state.product = null;
  openPanel();
  openSelfieStep();
}

function goToOwn() {
  $("own").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

// ---------- wiring ----------

function wire() {
  const onScroll = () => $("top").classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  $("nav-own").addEventListener("click", goToOwn);
  $("hero-own").addEventListener("click", goToOwn);
  $("empty-action").addEventListener("click", (e) => {
    if (e.currentTarget.dataset.mode === "own") return goToOwn();
    state.category = ""; state.query = ""; $("search").value = ""; renderTabs(); renderGrid();
  });

  $("search").addEventListener("input", debounce((e) => { state.query = e.target.value.trim(); renderGrid(); }, 150));

  $("panel-close").addEventListener("click", closePanel);
  $("overlay").addEventListener("click", (e) => { if (e.target === $("overlay")) closePanel(); });
  document.addEventListener("keydown", (e) => {
    if ($("overlay").hidden) return;
    if (e.key === "Escape") closePanel();
    else trapTab(e);
  });

  $("detail-try").addEventListener("click", openSelfieStep);
  $("selfie-take").addEventListener("click", () => $("selfie-camera").click());
  $("selfie-choose").addEventListener("click", () => $("selfie-gallery").click());
  $("selfie-replace").addEventListener("click", () => $("selfie-gallery").click());
  $("selfie-camera").addEventListener("change", (e) => setSelfie(e.target.files[0]));
  $("selfie-gallery").addEventListener("change", (e) => setSelfie(e.target.files[0]));
  wireDrop($("selfie-drop"), (files) => setSelfie(files[0]));
  $("selfie-submit").addEventListener("click", submitTryOn);
  $("selfie-back").addEventListener("click", () => {
    if (state.product) { showView("detail", state.product.name); focusPanel(); } else closePanel();
  });

  $("result-again").addEventListener("click", openSelfieStep);
  $("result-back").addEventListener("click", closePanel);
  $("failed-retry").addEventListener("click", openSelfieStep);
  $("failed-close").addEventListener("click", closePanel);

  $("own-add").addEventListener("click", () => $("own-files").click());
  $("own-files").addEventListener("change", (e) => addOwnFiles(e.target.files));
  wireDrop($("own-drop"), addOwnFiles);
  $("own-continue").addEventListener("click", startOwnFlow);
}

async function init() {
  wire();
  renderOwnStepper();
  renderOwnThumbs();
  renderSkeleton();
  renderHero();
  if (await loadStore()) await loadProducts();
}

init();
