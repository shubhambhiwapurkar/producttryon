/* Store admin: login, settings, website import, add/delete products. */
(function () {
  "use strict";

  const slug = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] || "");
  const STORAGE_KEY = `tryon-admin-${slug}`;
  const ANGLES = ["front", "side", "back", "worn", "detail"];
  const MAX_PHOTOS = 5;
  const $ = (id) => document.getElementById(id);

  const state = { token: "", store: null, photos: [] }; // photos: [{file, angle, url}]

  // ---------- helpers ----------

  function storageGet() { try { return localStorage.getItem(STORAGE_KEY) || ""; } catch (e) { return ""; } }
  function storageSet(v) { try { v ? localStorage.setItem(STORAGE_KEY, v) : localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ } }

  function errorMessage(body, status) {
    const detail = body && body.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail.map((d) => {
        const field = Array.isArray(d.loc) ? d.loc.filter((p) => p !== "body").join(" ") : "";
        return field ? `${field}: ${d.msg}` : d.msg;
      }).join("; ");
    }
    return `Something went wrong (error ${status}).`;
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (state.token) headers["X-Admin-Token"] = state.token;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      options = { ...options, body: JSON.stringify(options.json) };
    }
    let res;
    try {
      res = await fetch(path, { ...options, headers });
    } catch (e) {
      throw new Error("Could not reach the server. Check your connection and try again.");
    }
    if (res.status === 204) return null;
    let body = null;
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    if (res.status === 401) {
      const err = new Error(errorMessage(body, 401));
      err.unauthorized = true;
      throw err;
    }
    if (!res.ok) throw new Error(errorMessage(body, res.status));
    return body;
  }

  const base = `/api/stores/${encodeURIComponent(slug)}`;

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

  function setMsg(el, text, kind) {
    el.textContent = text || "";
    el.className = text ? `msg msg-${kind || "error"}` : "";
    show(el, Boolean(text));
  }

  /** Disable a button (and show it's busy) while an async task runs. */
  async function busy(button, task) {
    button.disabled = true;
    try { return await task(); } finally { button.disabled = false; }
  }

  function categoryLabel(cat) {
    const s = String(cat || "").replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function formatPrice(p) {
    const raw = p.price == null ? "" : String(p.price).trim();
    if (!raw) return "No price";
    const num = Number(raw.replace(/[, ]/g, ""));
    const cur = (p.currency || "INR").toUpperCase();
    if (!Number.isFinite(num)) return raw;
    const text = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(num);
    return cur === "INR" ? `₹${text}` : `${cur} ${text}`;
  }

  // ---------- login / logout ----------

  function showLogin(message) {
    show($("dash-view"), false);
    show($("login-view"), true);
    setMsg($("login-error"), message);
    $("token").focus();
  }

  async function login(token) {
    state.token = token;
    const store = await api(`${base}/admin/check`);
    state.store = store;
    storageSet(token);
    show($("login-view"), false);
    show($("dash-view"), true);
    renderStore();
    await loadProducts();
  }

  function logout() {
    storageSet("");
    state.token = "";
    $("token").value = "";
    showLogin("");
  }

  /** Called when any request is rejected as unauthorized. */
  function handleAuthError(err) {
    if (!err.unauthorized) return false;
    storageSet("");
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
        state.store = await api(base, { method: "PATCH", json: payload });
        renderStore();
        setMsg(msg, "Settings saved.", "ok");
      } catch (err) {
        if (!handleAuthError(err)) setMsg(msg, err.message);
      }
    });
  }

  async function copyLink() {
    const input = $("share-link");
    const btn = $("copy-link");
    try {
      await navigator.clipboard.writeText(input.value);
    } catch (e) {
      input.select();
      document.execCommand("copy");
    }
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 1800);
  }

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
        const r = await api(`${base}/import`, { method: "POST", json: { url, limit } });
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
    try { state.store = await api(`${base}/admin/check`); renderStore(); } catch (e) { /* non-critical */ }
  }

  // ---------- add product: photo slots ----------

  function renderPhotoSlots() {
    const wrap = $("photo-slots");
    wrap.replaceChildren();
    state.photos.forEach((photo, i) => {
      const select = h("select", { "aria-label": `Angle for photo ${i + 1}` });
      for (const a of ANGLES) {
        select.append(h("option", { value: a, text: categoryLabel(a), selected: a === photo.angle }));
      }
      select.value = photo.angle;
      select.addEventListener("change", () => { photo.angle = select.value; });
      const remove = h("button", { type: "button", class: "btn btn-sm btn-danger", text: "Remove", "aria-label": `Remove photo ${i + 1}` });
      remove.addEventListener("click", () => {
        URL.revokeObjectURL(photo.url);
        state.photos.splice(i, 1);
        renderPhotoSlots();
      });
      wrap.append(h("div", { class: "photo-slot" },
        h("div", { class: "thumb-item" }, h("img", { src: photo.url, alt: `Photo ${i + 1} preview` })),
        h("div", { class: "slot-ctrl" }, select, remove)));
    });
    $("p-add-photos").disabled = state.photos.length >= MAX_PHOTOS;
  }

  function addPhotos(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    const room = MAX_PHOTOS - state.photos.length;
    const used = new Set(state.photos.map((p) => p.angle));
    for (const file of files.slice(0, room)) {
      const angle = ANGLES.find((a) => !used.has(a)) || "detail";
      used.add(angle);
      state.photos.push({ file, angle, url: URL.createObjectURL(file) });
    }
    if (files.length > room) setMsg($("product-msg"), `Only ${MAX_PHOTOS} photos allowed. Extra photos were ignored.`, "info");
    $("p-files").value = "";
    renderPhotoSlots();
  }

  async function addProduct(e) {
    e.preventDefault();
    const msg = $("product-msg");
    setMsg(msg, "");
    if (state.photos.length === 0) return setMsg(msg, "Please add at least one photo.");
    const form = new FormData();
    form.append("name", $("p-name").value.trim());
    form.append("category", $("p-category").value);
    const optional = { price: "p-price", currency: "p-currency", dimensions: "p-dimensions", product_url: "p-url", description: "p-desc" };
    for (const [field, id] of Object.entries(optional)) {
      const v = $(id).value.trim();
      if (v) form.append(field, v);
    }
    for (const p of state.photos) {
      form.append("images", p.file);
      form.append("angles", p.angle);
    }
    await busy($("product-btn"), async () => {
      try {
        const product = await api(`${base}/products`, { method: "POST", body: form });
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
    state.photos.forEach((p) => URL.revokeObjectURL(p.url));
    state.photos = [];
    renderPhotoSlots();
  }

  // ---------- product list ----------

  async function loadProducts() {
    const msg = $("list-msg");
    try {
      const products = await api(`${base}/products`);
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
            h("span", { text: categoryLabel(p.category) }),
            h("span", { text: formatPrice(p) }),
            h("span", { text: `${p.images.length} photo${p.images.length === 1 ? "" : "s"}` }),
            h("span", { class: "badge", text: p.source || "manual" }))),
        h("div", { class: "pr-actions" }, del)));
    }
  }

  async function deleteProduct(p, button) {
    if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    const msg = $("list-msg");
    await busy(button, async () => {
      try {
        await api(`${base}/products/${p.id}`, { method: "DELETE" });
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
    $("p-add-photos").addEventListener("click", () => $("p-files").click());
    $("p-files").addEventListener("change", (e) => addPhotos(e.target.files));
  }

  async function init() {
    wire();
    renderPhotoSlots();
    $("login-store").textContent = `Enter your admin token to manage "${slug}".`;
    const saved = storageGet();
    if (!saved) return showLogin("");
    try { await login(saved); }
    catch (err) { state.token = ""; showLogin(err.unauthorized ? "Please log in again." : err.message); }
  }

  init();
})();
