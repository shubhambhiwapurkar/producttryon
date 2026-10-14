/* Customer page: browse the collection, try a piece on, compare before/after. */
import {
  $, h, show, setMsg, api, slugFromPath, categoryLabel, formatPrice, debounce, shrinkImage, TIPS,
  whatsappDigits, createCompare, createProgress, startProgressMessages, runTryOn, renderStepper,
} from "/static/common.js";

const slug = slugFromPath();
const showMessage = setMsg;

const state = {
store: null,
category: "",
query: "",
totalProducts: 0,
product: null, // product being tried, or null for "own piece"
ownFiles: [],
selfie: null,
run: 0, // increments to cancel in-flight polling
lastFocus: null,
stopMessages: null,
};

const progress = createProgress();
$("progress-slot").append(progress.root);

// ---------- store + collection ----------

async function loadStore() {
  try {
    state.store = await api(`/api/stores/${encodeURIComponent(slug)}`);
  } catch (err) {
    $("store-name").textContent = "Store not found";
    showMessage($("page-error"), err.message);
    $("tab-shop").closest(".tabs").hidden = true;
    $("panel-shop").hidden = true;
    return false;
  }
  document.title = `${state.store.name} – Virtual Try-On`;
  $("store-name").textContent = state.store.name;
  state.totalProducts = Object.values(state.store.categories).reduce((a, b) => a + b, 0);
  renderChips();
  fillCategorySelect();
  return true;
}

function renderChips() {
  const wrap = $("chips");
  wrap.replaceChildren();
  const cats = Object.entries(state.store.categories).filter(([, n]) => n > 0);
  if (cats.length <= 1) { show(wrap, false); return; }
  show(wrap, true);
  const make = (value, label, count) => {
    const chip = h("button", { type: "button", class: "chip", "aria-pressed": String(state.category === value) },
      label, count != null ? h("span", { class: "count", text: String(count) }) : null);
    chip.addEventListener("click", () => { state.category = value; renderChips(); loadProducts(); });
    return chip;
  };
  wrap.append(make("", "All", null));
  for (const [cat, n] of cats) wrap.append(make(cat, categoryLabel(cat), n));
}

function fillCategorySelect() {
  const sel = $("own-category");
  sel.replaceChildren(h("option", { value: "", text: "Choose a type…" }));
  for (const cat of state.store.all_categories) sel.append(h("option", { value: cat, text: categoryLabel(cat) }));
}

async function loadProducts() {
  const params = new URLSearchParams();
  if (state.category) params.set("category", state.category);
  if (state.query) params.set("q", state.query);
  try {
    const products = await api(`/api/stores/${encodeURIComponent(slug)}/products?${params}`);
    renderGrid(products);
  } catch (err) {
    showMessage($("page-error"), err.message);
  }
}

function renderGrid(products) {
  showMessage($("page-error"), "");
  const grid = $("grid");
  grid.replaceChildren();
  show($("empty"), products.length === 0);
  if (products.length === 0) {
    $("empty-text").textContent = state.totalProducts === 0
      ? "No products yet. Please check back soon, or try your own piece."
      : "No pieces match your search.";
  }
  products.forEach((p, i) => {
    const img = p.images[0];
    const thumb = h("div", { class: "thumb" }, img ? h("img", { src: img.url, alt: p.name, loading: "lazy" }) : null);
    const price = formatPrice(p);
    const card = h("button", { type: "button", class: "product-card", style: `animation-delay:${Math.min(i, 8) * 40}ms` },
      thumb,
      h("div", { class: "info" },
        h("div", { class: "cat", text: categoryLabel(p.category) }),
        h("div", { class: "name", text: p.name }),
        price ? h("div", { class: "price", text: price }) : null));
    card.addEventListener("click", () => openProduct(p));
    grid.append(card);
  });
  $("grid-status").textContent = `${products.length} piece${products.length === 1 ? "" : "s"} shown`;
}

// ---------- sheet ----------

const VIEWS = ["detail", "selfie", "progress", "result", "failed"];
// Which wizard step (0-based) each view belongs to.
const VIEW_STEP = { detail: 0, selfie: 1, progress: 1, failed: 1, result: 2 };

function renderTryStepper(view) {
  const labels = state.product
    ? ["Choose a piece", "Your photo", "Your look"]
    : ["Your piece", "Your photo", "Your look"];
  const step = VIEW_STEP[view];
  // Own-piece flow starts at step 2, so step 1 counts as done.
  renderStepper($("try-stepper"), labels, step, new Set(Array.from({ length: step }, (_, i) => i)), { compact: true });
}

function showView(name, title) {
  VIEWS.forEach((v) => show($(`view-${v}`), v === name));
  if (title) $("sheet-title").textContent = title;
  renderTryStepper(name);
  $("sheet").scrollTop = 0;
}

function openSheet() {
  state.lastFocus = document.activeElement;
  show($("overlay"), true);
  document.body.classList.add("no-scroll");
}

function closeSheet() {
  state.run++; // cancels polling
  stopMessages();
  show($("overlay"), false);
  document.body.classList.remove("no-scroll");
  if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
}

function focusSheet() { $("sheet-close").focus({ preventScroll: true }); }

// ---------- product detail ----------

function openProduct(product) {
  state.product = product;
  openSheet();
  showView("detail", product.name);
  renderGallery(product);
  $("detail-price").textContent = formatPrice(product);
  const desc = $("detail-desc");
  desc.textContent = product.description || "";
  show(desc, Boolean(product.description));
  const meta = $("detail-meta");
  meta.replaceChildren();
  const rows = [["Category", categoryLabel(product.category)], ["Dimensions", product.dimensions]];
  for (const [label, value] of rows) {
    if (value) meta.append(h("dt", { text: label }), h("dd", { text: value }));
  }
  const link = $("detail-link");
  const safeUrl = /^https?:\/\//i.test(product.product_url || "") ? product.product_url : "";
  if (safeUrl) link.href = safeUrl;
  show(link, Boolean(safeUrl));
  focusSheet();
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
  if (images.length === 0) { main.removeAttribute("src"); main.alt = ""; show(thumbs, false); return; }
  show(thumbs, images.length > 1);
  images.forEach((img, i) => {
    const btn = h("button", { type: "button", "aria-label": `Show photo ${i + 1}${img.angle ? ", " + img.angle : ""}` },
      h("img", { src: img.url, alt: "" }),
      img.angle ? h("span", { class: "angle", text: img.angle }) : null);
    btn.addEventListener("click", () => setMain(img, btn));
    thumbs.append(btn);
  });
  setMain(images[0], thumbs.firstChild);
}

// ---------- selfie step ----------

function currentCategory() {
  return state.product ? state.product.category : $("own-category").value;
}

function openSelfieStep() {
  const cat = currentCategory();
  const tip = $("selfie-tip");
  tip.replaceChildren(h("strong", { text: "Best photo: " }), TIPS[cat] || TIPS.other);
  clearSelfie();
  $("consent").checked = false;
  showMessage($("selfie-error"), "");
  showView("selfie", state.product ? `Try on: ${state.product.name}` : `Try on your ${categoryLabel(cat).toLowerCase()}`);
  focusSheet();
}

function clearSelfie() {
  state.selfie = null;
  $("selfie-camera").value = "";
  $("selfie-gallery").value = "";
  const prev = $("selfie-img").src;
  if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
  $("selfie-img").removeAttribute("src");
  show($("selfie-preview"), false);
}

function setSelfie(file) {
  if (!file) return;
  clearSelfie();
  state.selfie = file;
  $("selfie-img").src = URL.createObjectURL(file);
  show($("selfie-preview"), true);
  showMessage($("selfie-error"), "");
}

// ---------- submit + poll ----------

function stopMessages() {
  if (state.stopMessages) state.stopMessages();
  state.stopMessages = null;
}

async function submitTryOn() {
  const errBox = $("selfie-error");
  if (!state.selfie) return showMessage(errBox, "Please take or choose a photo of yourself first.");
  if (!$("consent").checked) return showMessage(errBox, "Please tick the consent box to continue.");
  showMessage(errBox, "");

  const run = ++state.run;
  showView("progress", state.product ? state.product.name : "Your preview");
  stopMessages();
  state.stopMessages = startProgressMessages(progress.msg);

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
  focusSheet();
}

// ---------- result ----------

function whatsappLink() {
  const digits = whatsappDigits(state.store && state.store.whatsapp_number);
  if (!digits) return "";
  const pageUrl = `${location.origin}${location.pathname}`;
  const text = state.product
    ? `Hi! I tried on ${state.product.name} (${pageUrl}) and would like to know more.`
    : `Hi! I tried on a piece of jewellery using your virtual try-on (${pageUrl}) and would like to know more.`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function showResult(job) {
  stopMessages();
  $("compare-slot").replaceChildren(createCompare(job.selfie_url, job.result_url));
  const dl = $("result-download");
  dl.href = job.result_url;
  dl.setAttribute("download", `${slug}-tryon.jpg`);
  const wa = whatsappLink();
  if (wa) $("result-wa").href = wa;
  show($("result-wa"), Boolean(wa));
  show($("demo-note"), job.renderer === "mock");
  showView("result", state.product ? state.product.name : "Your preview");
  focusSheet();
}

// ---------- own piece tab ----------

function renderOwnThumbs() {
  const list = $("own-thumbs");
  list.querySelectorAll("img").forEach((i) => URL.revokeObjectURL(i.src));
  list.replaceChildren();
  state.ownFiles.forEach((file, i) => {
    const remove = h("button", { type: "button", "aria-label": `Remove photo ${i + 1}`, text: "×" });
    remove.addEventListener("click", () => { state.ownFiles.splice(i, 1); renderOwnThumbs(); });
    list.append(h("div", { class: "thumb-item" },
      h("img", { src: URL.createObjectURL(file), alt: `Your piece, photo ${i + 1}` }), remove));
  });
  $("own-add").disabled = state.ownFiles.length >= 4;
}

function addOwnFiles(fileList) {
  const err = $("own-error");
  showMessage(err, "");
  const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
  const room = 4 - state.ownFiles.length;
  if (files.length > room) showMessage(err, "You can add up to 4 photos. Extra photos were ignored.");
  state.ownFiles.push(...files.slice(0, room));
  $("own-files").value = "";
  renderOwnThumbs();
}

function startOwnFlow() {
  const err = $("own-error");
  if (state.ownFiles.length === 0) return showMessage(err, "Please add at least one photo of the piece.");
  if (!$("own-category").value) return showMessage(err, "Please choose the type of jewellery.");
  showMessage(err, "");
  state.product = null;
  openSheet();
  openSelfieStep();
}

// ---------- tabs ----------

function selectTab(which) {
  const shop = which === "shop";
  $("tab-shop").setAttribute("aria-selected", String(shop));
  $("tab-own").setAttribute("aria-selected", String(!shop));
  $("tab-shop").tabIndex = shop ? 0 : -1;
  $("tab-own").tabIndex = shop ? -1 : 0;
  show($("panel-shop"), shop);
  show($("panel-own"), !shop);
}

// ---------- wiring ----------

function wire() {
  $("tab-shop").addEventListener("click", () => selectTab("shop"));
  $("tab-own").addEventListener("click", () => selectTab("own"));
  document.querySelector(".tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = $("tab-shop").getAttribute("aria-selected") === "true" ? "own" : "shop";
    selectTab(next);
    $(`tab-${next}`).focus();
  });

  $("search").addEventListener("input", debounce((e) => { state.query = e.target.value.trim(); loadProducts(); }, 250));

  $("sheet-close").addEventListener("click", closeSheet);
  $("overlay").addEventListener("click", (e) => { if (e.target === $("overlay")) closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("overlay").hidden) closeSheet(); });

  $("detail-try").addEventListener("click", openSelfieStep);
  $("selfie-take").addEventListener("click", () => $("selfie-camera").click());
  $("selfie-choose").addEventListener("click", () => $("selfie-gallery").click());
  $("selfie-camera").addEventListener("change", (e) => setSelfie(e.target.files[0]));
  $("selfie-gallery").addEventListener("change", (e) => setSelfie(e.target.files[0]));
  $("selfie-submit").addEventListener("click", submitTryOn);
  $("selfie-back").addEventListener("click", () => {
    if (state.product) { showView("detail", state.product.name); focusSheet(); } else closeSheet();
  });

  $("result-again").addEventListener("click", openSelfieStep);
  $("result-back").addEventListener("click", closeSheet);
  $("failed-retry").addEventListener("click", openSelfieStep);
  $("failed-close").addEventListener("click", closeSheet);

  $("own-add").addEventListener("click", () => $("own-files").click());
  $("own-files").addEventListener("change", (e) => addOwnFiles(e.target.files));
  $("own-continue").addEventListener("click", startOwnFlow);

}

async function init() {
  wire();
  renderOwnThumbs();
  if (await loadStore()) await loadProducts();
}

init();
