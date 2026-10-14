/* Customer page: browse the collection, try a piece on, compare before/after. */
(function () {
  "use strict";

  const slug = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] || "");
  const $ = (id) => document.getElementById(id);

  const TIPS = {
    necklace: "Face the camera with your neck and collarbones visible, and hair moved away from your neck.",
    pendant: "Face the camera with your neck and collarbones visible, and hair moved away from your neck.",
    earrings: "Ears clearly visible, with hair tucked behind your ears. A slight turn of the head works well.",
    ring: "Photo of your hand, palm down, fingers slightly apart, in good light.",
    bracelet: "Photo of your wrist and hand, palm down, in good light.",
    bangle: "Photo of your wrist and hand, palm down, in good light.",
    nose_pin: "Front-facing photo with your nose and face clearly visible, in good light.",
    maang_tikka: "Front-facing photo with your forehead and hair parting clearly visible.",
    anklet: "Photo of your foot and ankle, in good light, with the ankle clear of clothing.",
    other: "Use a clear, well-lit photo of the part of you where the piece is worn.",
  };

  const PROGRESS_MESSAGES = [
    "Uploading your photo…",
    "Studying the piece…",
    "Finding the perfect fit…",
    "Adding the sparkle…",
    "Polishing the final look…",
    "Almost there…",
  ];

  const POLL_MS = 2000;
  const GIVE_UP_MS = 3 * 60 * 1000;

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
  };

  // ---------- helpers ----------

  async function api(path, options) {
    let res;
    try {
      res = await fetch(path, options);
    } catch (err) {
      throw new Error("Could not reach the server. Check your connection and try again.");
    }
    if (res.status === 204) return null;
    let body = null;
    try { body = await res.json(); } catch (err) { /* not JSON */ }
    if (!res.ok) throw new Error(errorMessage(body, res.status));
    return body;
  }

  function errorMessage(body, status) {
    const detail = body && body.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail.map((d) => {
        const field = Array.isArray(d.loc) ? d.loc.filter((p) => p !== "body").join(" ") : "";
        return field ? `${field}: ${d.msg}` : d.msg;
      }).join("; ");
    }
    return `Something went wrong (error ${status}). Please try again.`;
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) el.append(c);
    return el;
  }

  function show(el, visible) { el.hidden = !visible; }

  function showMessage(el, text) {
    el.textContent = text || "";
    show(el, Boolean(text));
  }

  function categoryLabel(cat) {
    const s = String(cat || "").replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function formatPrice(product) {
    const raw = product.price == null ? "" : String(product.price).trim();
    if (!raw) return "";
    const num = Number(raw.replace(/[, ]/g, ""));
    const currency = (product.currency || "INR").toUpperCase();
    if (!Number.isFinite(num)) return raw;
    const text = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(num);
    return currency === "INR" ? `₹${text}` : `${currency} ${text}`;
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /** Downscale big phone photos before upload (faster, avoids the size limit). */
  async function shrinkImage(file, maxSide = 2000) {
    try {
      if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      if (scale === 1 && file.size < 3 * 1024 * 1024) { bitmap.close(); return file; }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
      if (!blob) return file;
      return new File([blob], (file.name || "photo").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
    } catch (err) {
      return file; // let the server decide
    }
  }

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

  function showView(name, title) {
    VIEWS.forEach((v) => show($(`view-${v}`), v === name));
    if (title) $("sheet-title").textContent = title;
    $("sheet").scrollTop = 0;
  }

  function openSheet() {
    state.lastFocus = document.activeElement;
    show($("overlay"), true);
    document.body.classList.add("no-scroll");
  }

  function closeSheet() {
    state.run++; // cancels polling
    clearInterval(progressTimer);
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

  let progressTimer = null;

  function startProgressMessages() {
    let i = 0;
    const msg = $("progress-msg");
    msg.textContent = PROGRESS_MESSAGES[0];
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      i = Math.min(i + 1, PROGRESS_MESSAGES.length - 1);
      msg.textContent = PROGRESS_MESSAGES[i];
    }, 5000);
  }

  async function submitTryOn() {
    const errBox = $("selfie-error");
    if (!state.selfie) return showMessage(errBox, "Please take or choose a photo of yourself first.");
    if (!$("consent").checked) return showMessage(errBox, "Please tick the consent box to continue.");
    showMessage(errBox, "");

    const run = ++state.run;
    showView("progress", state.product ? state.product.name : "Your preview");
    startProgressMessages();

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
      const job = await api(`/api/stores/${encodeURIComponent(slug)}/tryons`, { method: "POST", body: form });
      if (run !== state.run) return;
      await pollTryOn(job.id, run);
    } catch (err) {
      if (run === state.run) fail(err.message);
    }
  }

  async function pollTryOn(id, run) {
    const started = Date.now();
    while (run === state.run) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (run !== state.run) return;
      if (Date.now() - started > GIVE_UP_MS) return fail("This is taking longer than expected. Please try again in a moment.");
      let job;
      try {
        job = await api(`/api/tryons/${encodeURIComponent(id)}`);
      } catch (err) {
        continue; // transient network error: keep trying until the deadline
      }
      if (run !== state.run) return;
      if (job.status === "done") return showResult(job);
      if (job.status === "failed") return fail(job.error);
    }
  }

  function fail(message) {
    clearInterval(progressTimer);
    $("failed-msg").textContent = message || "We couldn't create this preview. Please try another photo.";
    showView("failed", "Something went wrong");
    focusSheet();
  }

  // ---------- result ----------

  function whatsappLink() {
    const digits = String((state.store && state.store.whatsapp_number) || "").replace(/\D/g, "");
    if (!digits) return "";
    const pageUrl = `${location.origin}${location.pathname}`;
    const text = state.product
      ? `Hi! I tried on ${state.product.name} (${pageUrl}) and would like to know more.`
      : `Hi! I tried on a piece of jewellery using your virtual try-on (${pageUrl}) and would like to know more.`;
    return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
  }

  function showResult(job) {
    clearInterval(progressTimer);
    $("compare-after").src = job.result_url;
    $("compare-before").src = job.selfie_url;
    setComparePos(50);
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

  // before/after slider
  function setComparePos(pct) {
    const p = Math.max(0, Math.min(100, pct));
    $("compare").style.setProperty("--pos", `${p}%`);
    $("compare-handle").setAttribute("aria-valuenow", String(Math.round(p)));
  }

  function initSlider() {
    const box = $("compare");
    const handle = $("compare-handle");
    let dragging = false;
    const move = (clientX) => {
      const rect = box.getBoundingClientRect();
      setComparePos(((clientX - rect.left) / rect.width) * 100);
    };
    box.addEventListener("pointerdown", (e) => {
      dragging = true;
      box.setPointerCapture(e.pointerId);
      move(e.clientX);
      e.preventDefault();
    });
    box.addEventListener("pointermove", (e) => { if (dragging) move(e.clientX); });
    const stop = () => { dragging = false; };
    box.addEventListener("pointerup", stop);
    box.addEventListener("pointercancel", stop);
    handle.addEventListener("keydown", (e) => {
      const cur = Number(handle.getAttribute("aria-valuenow"));
      if (e.key === "ArrowLeft") { setComparePos(cur - 5); e.preventDefault(); }
      if (e.key === "ArrowRight") { setComparePos(cur + 5); e.preventDefault(); }
      if (e.key === "Home") { setComparePos(0); e.preventDefault(); }
      if (e.key === "End") { setComparePos(100); e.preventDefault(); }
    });
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

    initSlider();
  }

  async function init() {
    wire();
    renderOwnThumbs();
    if (await loadStore()) await loadProducts();
  }

  init();
})();
