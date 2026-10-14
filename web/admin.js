/* Studio: the jeweller's back office. */
import {
  $, h, show, api, slugFromPath, storageGet, storageSet, categoryLabel, formatPrice,
} from "/static/common.js";
import {
  icon, toast, confirmDialog, savedTick, buildProductForm, buildImporter, buildSharePanel, sourceLabel, adminTokenKey,
} from "/static/studio-common.js";

const slug = slugFromPath();
const base = `/api/stores/${encodeURIComponent(slug)}`;
const VIEWS = ["overview", "collection", "add", "import", "settings", "share"];

const state = { token: "", store: null, products: [], q: "", filter: "", built: new Set() };

const call = (path, options = {}) => api(path, { ...options, token: state.token }).catch((err) => {
  if (err.unauthorized) signedOut("Your session has ended. Please enter your key again.");
  throw err;
});

const say = (el, text) => { el.textContent = text || ""; el.className = text ? "msg msg-error" : ""; el.hidden = !text; };

// ---------- sign in / out ----------

function showLogin(message) {
  show($("app"), false);
  show($("login-view"), true);
  say($("login-error"), message);
  $("token").focus();
}

function signedOut(message) {
  storageSet(adminTokenKey(slug), null);
  state.token = "";
  state.built.clear();
  $("token").value = "";
  showLogin(message);
}

async function login(token) {
  state.token = token;
  state.store = await api(`${base}/admin/check`, { token });
  storageSet(adminTokenKey(slug), token);
  show($("login-view"), false);
  show($("app"), true);
  paintStore();
  await loadProducts();
  route();
}

// ---------- store ----------

function paintStore() {
  const s = state.store;
  document.title = `${s.name} · Studio`;
  $("brand").textContent = s.name;
  $("view-shop").href = `/s/${encodeURIComponent(slug)}`;
  $("set-name").value = s.name || "";
  $("set-wa").value = s.whatsapp_number || "";
  $("set-web").value = s.website_url || "";
  const filter = $("filter");
  const current = filter.value;
  filter.replaceChildren(h("option", { value: "", text: "All types" }));
  for (const c of s.all_categories) filter.append(h("option", { value: c, text: categoryLabel(c) }));
  filter.value = current;
}

async function refreshStore() {
  try { state.store = await api(`${base}/admin/check`, { token: state.token }); paintStore(); } catch (e) { /* non-critical */ }
}

async function loadProducts() {
  try {
    state.products = await api(`${base}/products`);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function reloadAll() {
  await Promise.all([loadProducts(), refreshStore()]);
  paintCollection();
  paintOverview();
}

// ---------- routing ----------

function route() {
  let name = location.hash.replace(/^#\/?/, "");
  if (!VIEWS.includes(name)) name = "overview";
  for (const el of document.querySelectorAll("[data-view]")) {
    const on = el.dataset.view === name;
    el.hidden = !on;
    if (on) { el.classList.remove("fade-in"); void el.offsetWidth; el.classList.add("fade-in"); }
  }
  for (const a of document.querySelectorAll("[data-nav]")) {
    if (a.dataset.nav === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  const active = document.querySelector(`[data-nav="${name}"]`);
  if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest", inline: "center" });
  build(name);
  window.scrollTo({ top: 0 });
}

function build(name) {
  if (name === "overview") paintOverview();
  if (name === "collection") paintCollection();
  if (state.built.has(name)) return;
  if (name === "add") {
    $("add-host").append(buildProductForm({
      categories: state.store.all_categories, full: true, submitLabel: "Add to collection",
      create: (fd) => call(`${base}/products`, { method: "POST", body: fd }),
      onAdded: reloadAll,
    }));
  } else if (name === "import") {
    $("import-host").append(buildImporter({
      call, base, defaultUrl: state.store.website_url || "", idPrefix: "imp", onDone: reloadAll,
    }));
  } else if (name === "share") {
    $("share-host").append(buildSharePanel({ slug, wide: true, idPrefix: "sh" }));
  } else return;
  state.built.add(name);
}

// ---------- overview ----------

function paintOverview() {
  const host = $("overview-body");
  if (!host || $("app").hidden) return;
  const products = state.products;
  const cats = state.store.categories || {};
  const catEntries = Object.entries(cats).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const photos = products.reduce((n, p) => n + p.images.length, 0);
  $("ov-title").replaceChildren(state.store.name);
  host.replaceChildren();

  if (!products.length) {
    host.append(h("div", { class: "setup-card" },
      h("div", {},
        h("p", { class: "eyebrow", text: "Getting started" }),
        h("h3", { text: "Finish setting up your boutique" }),
        h("p", { class: "small", text: "Add your first pieces so customers can try them on. It takes a few minutes." })),
      h("a", { class: "btn btn-primary", href: `/onboard?store=${encodeURIComponent(slug)}`, text: "Continue setup" })));
  }

  const tile = (num, label) => h("div", { class: "stat" }, h("span", { class: "stat-num", text: String(num) }), h("span", { class: "eyebrow", text: label }));
  host.append(h("div", { class: "stats" }, tile(products.length, "Pieces"), tile(catEntries.length, "Types"), tile(photos, "Photographs")));

  if (catEntries.length) {
    const max = catEntries[0][1];
    const list = h("ul", { class: "bars" });
    for (const [cat, n] of catEntries) {
      list.append(h("li", {},
        h("span", { class: "bar-name", text: categoryLabel(cat) }),
        h("span", { class: "bar-track", "aria-hidden": "true" }, h("span", { style: `width:${Math.max(6, (n / max) * 100)}%` })),
        h("span", { class: "bar-n", text: String(n) })));
    }
    host.append(h("div", { class: "block" }, h("p", { class: "eyebrow", text: "By type" }), list));
  }

  const action = (href, title, text) => h("a", { class: "action", href }, h("span", {}, h("strong", { text: title }), h("span", { class: "small", text })), icon("arrow", 20));
  host.append(h("div", { class: "block" }, h("p", { class: "eyebrow", text: "Quick actions" }),
    h("div", { class: "actions" },
      action("#add", "Add a piece", "Photograph and describe a new piece"),
      action("#import", "Import from website", "Bring your existing shop across"),
      action("#share", "Share your boutique", "Link, QR code and WhatsApp message"))));
}

// ---------- collection ----------

function paintCollection() {
  const list = $("rows");
  if (!list) return;
  const q = state.q.trim().toLowerCase();
  const items = state.products.filter((p) => (!state.filter || p.category === state.filter) && (!q || p.name.toLowerCase().includes(q)));
  list.replaceChildren();
  const total = state.products.length;
  $("count").textContent = total ? `${items.length} of ${total} piece${total === 1 ? "" : "s"}` : "";
  const empty = $("rows-empty");
  show(empty, items.length === 0);
  if (!items.length) {
    empty.replaceChildren(total
      ? h("p", { class: "small", text: "No pieces match your search." })
      : h("div", {}, h("p", { class: "display-sm", text: "Your collection is empty" }),
        h("p", { class: "small", text: "Add your first piece, or import your catalogue from your website." }),
        h("div", { class: "empty-actions" }, h("a", { class: "btn btn-primary", href: "#add", text: "Add a piece" }), h("a", { class: "btn", href: "#import", text: "Import" }))));
  }
  for (const p of items) list.append(row(p));
}

function row(p) {
  const tick = savedTick();
  const sel = h("select", { "aria-label": `Type of ${p.name}` });
  for (const c of state.store.all_categories) sel.append(h("option", { value: c, text: categoryLabel(c) }));
  sel.value = p.category;
  sel.addEventListener("change", async () => {
    const previous = p.category;
    sel.disabled = true;
    try {
      await call(`${base}/products/${p.id}`, { method: "PATCH", json: { category: sel.value } });
      p.category = sel.value;
      tick.flash();
      refreshStore().then(() => { if (!location.hash || location.hash === "#overview") paintOverview(); });
    } catch (err) {
      sel.value = previous;
      toast(err.message, "error");
    } finally { sel.disabled = false; }
  });

  const del = h("button", { type: "button", class: "icon-btn", "aria-label": `Delete ${p.name}` }, icon("trash", 18));
  del.addEventListener("click", async () => {
    if (!await confirmDialog({ title: "Delete this piece?", body: `${p.name} and its photographs will be permanently removed.`, confirmLabel: "Delete", danger: true })) return;
    try {
      await call(`${base}/products/${p.id}`, { method: "DELETE" });
      toast("Piece deleted");
      await reloadAll();
    } catch (err) { toast(err.message, "error"); }
  });

  const img = p.images[0];
  const n = p.images.length;
  return h("li", { class: "row" },
    h("div", { class: "well row-thumb" }, img ? h("img", { src: img.url, alt: "", loading: "lazy" }) : null),
    h("div", { class: "row-main" },
      h("p", { class: "row-name", text: p.name }),
      h("p", { class: "row-meta" }, h("span", { class: `badge${p.source === "import" ? " badge-gold" : ""}`, text: sourceLabel(p.source) }), h("span", { class: "small", text: `${n} photograph${n === 1 ? "" : "s"}` }))),
    h("div", { class: "row-type" }, sel, tick.el),
    h("p", { class: "row-price", text: formatPrice(p, "No price") }),
    del);
}

// ---------- settings ----------

async function saveSettings(e) {
  e.preventDefault();
  const err = $("settings-error");
  say(err, "");
  const name = $("set-name").value.trim();
  if (!name) return say(err, "Please give your boutique a name.");
  let web = $("set-web").value.trim();
  if (web && !/^https?:\/\//i.test(web)) web = `https://${web}`;
  const btn = $("settings-btn");
  btn.classList.add("is-busy"); btn.disabled = true;
  try {
    state.store = await call(base, { method: "PATCH", json: { name, whatsapp_number: $("set-wa").value.trim(), website_url: web } });
    paintStore();
    toast("Settings saved");
  } catch (ex) { say(err, ex.message); } finally { btn.classList.remove("is-busy"); btn.disabled = false; }
}

// ---------- init ----------

async function init() {
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = $("token").value.trim();
    if (!token) return say($("login-error"), "Please enter your studio key.");
    say($("login-error"), "");
    const btn = $("login-btn");
    btn.classList.add("is-busy"); btn.disabled = true;
    try { await login(token); }
    catch (err) { state.token = ""; say($("login-error"), err.unauthorized ? "That key isn't right. Please check it and try again." : err.message); }
    finally { btn.classList.remove("is-busy"); btn.disabled = false; }
  });
  $("logout").addEventListener("click", () => signedOut(""));
  $("settings-form").addEventListener("submit", saveSettings);
  $("q").addEventListener("input", (e) => { state.q = e.target.value; paintCollection(); });
  $("filter").addEventListener("change", (e) => { state.filter = e.target.value; paintCollection(); });
  window.addEventListener("hashchange", route);

  // Show the boutique's name on the sign-in screen.
  api(base).then((s) => {
    $("login-brand").textContent = s.name;
    $("login-brand").setAttribute("href", `/s/${encodeURIComponent(slug)}`);
    document.title = `${s.name} · Studio`;
  }).catch((err) => {
    if (err.status === 404) say($("login-error"), "We could not find a boutique at this address.");
  });

  const saved = storageGet(adminTokenKey(slug));
  if (!saved) return showLogin("");
  try { await login(saved); }
  catch (err) { state.token = ""; showLogin(err.unauthorized ? "Please enter your key again." : err.message); }
}

init();
