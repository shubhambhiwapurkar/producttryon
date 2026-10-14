import {
  $, h, show, setMsg, busy, api, slugFromPath, storageGet, storageSet, categoryLabel, formatPrice, copyText, createPhotoSlots,
} from "/static/common.js";

const slug = slugFromPath();
const STORAGE_KEY = `tryon-admin-${slug}`;
const MAX_PHOTOS = 5;
const base = `/api/stores/${encodeURIComponent(slug)}`;

const state = { token: "", store: null };

/** API call with the admin token attached. */
const call = (path, options = {}) => api(path, { ...options, token: state.token });
const storageGetToken = () => storageGet(STORAGE_KEY) || "";
const storageSetToken = (v) => storageSet(STORAGE_KEY, v || null);

// ---------- login / logout ----------

function showLogin(message) {
  show($("dash-view"), false);
  show($("login-view"), true);
  setMsg($("login-error"), message);
  $("token").focus();
}

async function login(token) {
  state.token = token;
  const store = await call(`${base}/admin/check`);
  state.store = store;
  storageSetToken(token);
  show($("login-view"), false);
  show($("dash-view"), true);
  renderStore();
  await loadProducts();
}

function logout() {
  storageSetToken("");
  state.token = "";
  $("token").value = "";
  showLogin("");
}

/** Called when any request is rejected as unauthorized. */
function handleAuthError(err) {
  if (!err.unauthorized) return false;
  storageSetToken("");
  state.token = "";
  showLogin("Your session expired. Please enter your admin token again.");
  return true;
}

// ---------- settings ----------

function renderStore() {
  const s = state.store;
  document.title = `${s.name} – Admin`;
  $("admin-title").textContent = s.name;
  $("set-name").value = s.name || "";
  $("set-wa").value = s.whatsapp_number || "";
  $("set-web").value = s.website_url || "";
  $("share-link").value = `${location.origin}/s/${slug}`;
  $("view-shop").href = `/s/${encodeURIComponent(slug)}`;
  $("setup-link").href = `/onboard?store=${encodeURIComponent(slug)}`;
  const sel = $("p-category");
  if (sel.options.length === 0) {
    for (const c of s.all_categories) sel.append(h("option", { value: c, text: categoryLabel(c) }));
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const msg = $("settings-msg");
  setMsg(msg, "");
  // Empty strings clear the optional fields.
  const payload = {
    name: $("set-name").value.trim(),
    whatsapp_number: $("set-wa").value.trim(),
    website_url: $("set-web").value.trim(),
  };
  await busy($("settings-btn"), async () => {
    try {
      state.store = await call(base, { method: "PATCH", json: payload });
      renderStore();
      setMsg(msg, "Settings saved.", "ok");
    } catch (err) {
      if (!handleAuthError(err)) setMsg(msg, err.message);
    }
  });
}

function copyLink() { copyText($("share-link").value, $("copy-link")); }

// ---------- import ----------

async function runImport(e) {
  e.preventDefault();
  const msg = $("import-msg");
  setMsg(msg, "");
  const url = $("imp-url").value.trim();
  const limit = Math.max(1, Math.min(200, parseInt($("imp-limit").value, 10) || 20));
  show($("import-status"), true);
  await busy($("import-btn"), async () => {
    try {
      const r = await call(`${base}/import`, { method: "POST", json: { url, limit } });
      setMsg(msg, `Found ${r.found} • Imported ${r.imported} • Already in your store ${r.skipped_existing} • Failed ${r.failed}`,
        r.imported > 0 || r.found > 0 ? "ok" : "info");
      await loadProducts();
      refreshStoreInfo();
    } catch (err) {
      if (!handleAuthError(err)) setMsg(msg, err.message);
    } finally {
      show($("import-status"), false);
    }
  });
}

async function refreshStoreInfo() {
  try { state.store = await call(`${base}/admin/check`); renderStore(); } catch (e) { /* non-critical */ }
}

// ---------- add product ----------

const slots = createPhotoSlots({
  container: $("photo-slots"), fileInput: $("p-files"), addButton: $("p-add-photos"), max: MAX_PHOTOS,
  onNotice: (text) => setMsg($("product-msg"), text, "info"),
});

async function addProduct(e) {
  e.preventDefault();
  const msg = $("product-msg");
  setMsg(msg, "");
  if (slots.photos.length === 0) return setMsg(msg, "Please add at least one photo.");
  const form = new FormData();
  form.append("name", $("p-name").value.trim());
  form.append("category", $("p-category").value);
  const optional = { price: "p-price", currency: "p-currency", dimensions: "p-dimensions", product_url: "p-url", description: "p-desc" };
  for (const [field, id] of Object.entries(optional)) {
    const v = $(id).value.trim();
    if (v) form.append(field, v);
  }
  slots.appendTo(form);
  await busy($("product-btn"), async () => {
    try {
      const product = await call(`${base}/products`, { method: "POST", body: form });
      setMsg(msg, `Added "${product.name}".`, "ok");
      resetProductForm();
      await loadProducts();
      refreshStoreInfo();
    } catch (err) {
      if (!handleAuthError(err)) setMsg(msg, err.message);
    }
  });
}

function resetProductForm() {
  for (const id of ["p-name", "p-price", "p-dimensions", "p-url", "p-desc"]) $(id).value = "";
  $("p-currency").value = "INR";
  slots.reset();
}

// ---------- product list ----------

async function loadProducts() {
  const msg = $("list-msg");
  try {
    const products = await call(`${base}/products`);
    renderProducts(products);
    setMsg(msg, "");
  } catch (err) {
    if (!handleAuthError(err)) setMsg(msg, err.message);
  }
}

function renderProducts(products) {
  const list = $("product-list");
  list.replaceChildren();
  $("product-count").textContent = String(products.length);
  show($("list-empty"), products.length === 0);
  show($("setup-banner"), products.length === 0);
  for (const p of products) {
    const thumb = p.images[0]
      ? h("img", { src: p.images[0].url, alt: p.name, loading: "lazy" })
      : h("div", { class: "thumb-item", "aria-hidden": "true" });
    const del = h("button", { type: "button", class: "btn btn-sm btn-danger", text: "Delete", "aria-label": `Delete ${p.name}` });
    del.addEventListener("click", () => deleteProduct(p, del));
    list.append(h("div", { class: "product-row" },
      thumb,
      h("div", { class: "pr-main" },
        h("div", { class: "pr-name", text: p.name }),
        h("div", { class: "pr-meta" },
          categorySelect(p),
          h("span", { text: formatPrice(p, "No price") }),
          h("span", { text: `${p.images.length} photo${p.images.length === 1 ? "" : "s"}` }),
          h("span", { class: "badge", text: p.source || "manual" }))),
      h("div", { class: "pr-actions" }, del)));
  }
}

/** Inline category editor: change the select to save immediately. */
function categorySelect(p) {
  const sel = h("select", { class: "pr-cat", "aria-label": `Category for ${p.name}` });
  for (const c of state.store.all_categories) sel.append(h("option", { value: c, text: categoryLabel(c) }));
  sel.value = p.category;
  sel.addEventListener("change", async () => {
    sel.disabled = true;
    try {
      await call(`${base}/products/${p.id}`, { method: "PATCH", json: { category: sel.value } });
      p.category = sel.value;
      setMsg($("list-msg"), `Updated "${p.name}" to ${categoryLabel(sel.value).toLowerCase()}.`, "ok");
      refreshStoreInfo();
    } catch (err) {
      sel.value = p.category;
      if (!handleAuthError(err)) setMsg($("list-msg"), err.message);
    } finally {
      sel.disabled = false;
    }
  });
  return sel;
}

async function deleteProduct(p, button) {
  if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
  const msg = $("list-msg");
  await busy(button, async () => {
    try {
      await call(`${base}/products/${p.id}`, { method: "DELETE" });
      await loadProducts();
      refreshStoreInfo();
    } catch (err) {
      if (!handleAuthError(err)) setMsg(msg, err.message);
    }
  });
}

// ---------- init ----------

function wire() {
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = $("token").value.trim();
    if (!token) return setMsg($("login-error"), "Please enter your admin token.");
    setMsg($("login-error"), "");
    await busy($("login-btn"), async () => {
      try { await login(token); }
      catch (err) { state.token = ""; setMsg($("login-error"), err.unauthorized ? "That token isn't right. Please check and try again." : err.message); }
    });
  });
  $("logout").addEventListener("click", logout);
  $("settings-form").addEventListener("submit", saveSettings);
  $("copy-link").addEventListener("click", copyLink);
  $("share-link").addEventListener("focus", (e) => e.target.select());
  $("import-form").addEventListener("submit", runImport);
  $("product-form").addEventListener("submit", addProduct);
    }

async function init() {
  wire();
  $("login-store").textContent = `Enter your admin token to manage "${slug}".`;
  const saved = storageGetToken();
  if (!saved) return showLogin("");
  try { await login(saved); }
  catch (err) { state.token = ""; showLogin(err.unauthorized ? "Please log in again." : err.message); }
}

init();
