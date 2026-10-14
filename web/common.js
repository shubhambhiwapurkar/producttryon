/* Helpers shared by the customer page, the admin page and the onboarding wizard. */

export const $ = (id) => document.getElementById(id);

/** Store slug from the URL: /s/<slug>, /admin/<slug>. */
export function slugFromPath() {
  return decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] || "");
}

// ---------- DOM ----------

/** Tiny element builder. Text goes through textContent, so it is always escaped. */
export function h(tag, attrs, ...children) {
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

export function show(el, visible) { el.hidden = !visible; }

/** Show a message in a status box (kind: error | ok | info); empty text hides it. */
export function setMsg(el, text, kind = "error") {
  el.textContent = text || "";
  el.className = text ? `msg msg-${kind}` : "";
  show(el, Boolean(text));
}

/** Disable a button while an async task runs. */
export async function busy(button, task) {
  button.disabled = true;
  try { return await task(); } finally { button.disabled = false; }
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function copyText(text, button, doneLabel = "Copied!") {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = h("textarea", { "aria-hidden": "true", style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (err) { /* ignore */ }
    ta.remove();
  }
  if (button) {
    const old = button.textContent;
    button.textContent = doneLabel;
    setTimeout(() => { button.textContent = old; }, 1800);
  }
}

// ---------- storage (never throws) ----------

export function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
export function storageSet(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch (e) { /* ignore */ }
}

// ---------- API ----------

export function errorMessage(body, status) {
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

/**
 * fetch wrapper. Options: method, body (FormData), json (object), token (admin token).
 * Throws Error(server detail); err.status and err.unauthorized are set for HTTP errors.
 */
export async function api(path, { json, token, headers, ...options } = {}) {
  const h2 = { ...(headers || {}) };
  if (token) h2["X-Admin-Token"] = token;
  if (json !== undefined) { h2["Content-Type"] = "application/json"; options.body = JSON.stringify(json); }
  let res;
  try {
    res = await fetch(path, { ...options, headers: h2 });
  } catch (e) {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  if (res.status === 204) return null;
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const err = new Error(errorMessage(body, res.status));
    err.status = res.status;
    err.unauthorized = res.status === 401;
    throw err;
  }
  return body;
}

// ---------- formatting ----------

export function categoryLabel(cat) {
  const s = String(cat || "").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "₹1,250" for INR, "USD 1,250" otherwise; "" when there is no price. */
export function formatPrice(product, emptyText = "") {
  const raw = product.price == null ? "" : String(product.price).trim();
  if (!raw) return emptyText;
  const num = Number(raw.replace(/[, ]/g, ""));
  const currency = (product.currency || "INR").toUpperCase();
  if (!Number.isFinite(num)) return raw;
  const text = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(num);
  return currency === "INR" ? `₹${text}` : `${currency} ${text}`;
}

export function slugify(name) {
  const s = String(name || "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  return s || "store";
}

export function whatsappDigits(number) { return String(number || "").replace(/\D/g, ""); }

// ---------- photo tips ----------

export const TIPS = {
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

// ---------- images ----------

/** Downscale big phone photos before upload (faster, stays under the size limit). */
export async function shrinkImage(file, maxSide = 2000) {
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
  } catch (e) {
    return file; // let the server decide
  }
}

// ---------- try-on: progress messages, polling, before/after slider ----------

const PROGRESS_MESSAGES = [
  "Uploading your photo…",
  "Studying the piece…",
  "Finding the perfect fit…",
  "Adding the sparkle…",
  "Polishing the final look…",
  "Almost there…",
];

/** Rotate friendly messages in `el`. Returns a function that stops the rotation. */
export function startProgressMessages(el) {
  let i = 0;
  el.textContent = PROGRESS_MESSAGES[0];
  const timer = setInterval(() => {
    i = Math.min(i + 1, PROGRESS_MESSAGES.length - 1);
    el.textContent = PROGRESS_MESSAGES[i];
  }, 5000);
  return () => clearInterval(timer);
}

/** Markup for the animated loader used while a try-on renders. */
export function createProgress() {
  const msg = h("div", { class: "progress-msg", role: "status", "aria-live": "polite" });
  const root = h("div", { class: "progress" },
    h("div", { class: "gem", "aria-hidden": "true" }),
    msg,
    h("div", { class: "progress-bar", "aria-hidden": "true" }),
    h("p", { class: "hint", style: "margin-top:18px", text: "This usually takes 10–40 seconds. Please keep this page open." }));
  return { root, msg };
}

/**
 * Upload the photos and wait for the render.
 * `form` is a FormData with selfie/consent/(product_id | category + product_images).
 * `isCancelled()` lets the caller abandon a run. Resolves with the finished job,
 * rejects with an Error whose message is safe to show.
 */
export async function runTryOn(slug, form, isCancelled = () => false) {
  const job = await api(`/api/stores/${encodeURIComponent(slug)}/tryons`, { method: "POST", body: form });
  const started = Date.now();
  while (!isCancelled()) {
    await sleep(2000);
    if (isCancelled()) break;
    if (Date.now() - started > 3 * 60 * 1000) throw new Error("This is taking longer than expected. Please try again in a moment.");
    let status;
    try {
      status = await api(`/api/tryons/${encodeURIComponent(job.id)}`);
    } catch (e) {
      continue; // transient network error: keep trying until the deadline
    }
    if (status.status === "done") return status;
    if (status.status === "failed") throw new Error(status.error || "We couldn't create this preview. Please try another photo.");
  }
  return null; // cancelled
}

/** Draggable before/after comparison. Works with mouse, touch and keyboard. */
export function createCompare(beforeUrl, afterUrl) {
  const handle = h("button", {
    type: "button", class: "handle", role: "slider", "aria-label": "Compare before and after",
    "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "50", text: "↔",
  });
  const root = h("div", { class: "compare" },
    h("img", { src: afterUrl, alt: "You wearing the jewellery (after)" }),
    h("div", { class: "before-wrap" }, h("img", { src: beforeUrl, alt: "Your original photo (before)" })),
    h("div", { class: "divider", "aria-hidden": "true" }),
    handle,
    h("span", { class: "tag left", text: "Before" }),
    h("span", { class: "tag right", text: "After" }));

  const setPos = (pct) => {
    const p = Math.max(0, Math.min(100, pct));
    root.style.setProperty("--pos", `${p}%`);
    handle.setAttribute("aria-valuenow", String(Math.round(p)));
  };
  const move = (clientX) => {
    const rect = root.getBoundingClientRect();
    setPos(((clientX - rect.left) / rect.width) * 100);
  };
  let dragging = false;
  root.addEventListener("pointerdown", (e) => { dragging = true; root.setPointerCapture(e.pointerId); move(e.clientX); e.preventDefault(); });
  root.addEventListener("pointermove", (e) => { if (dragging) move(e.clientX); });
  const stop = () => { dragging = false; };
  root.addEventListener("pointerup", stop);
  root.addEventListener("pointercancel", stop);
  handle.addEventListener("keydown", (e) => {
    const cur = Number(handle.getAttribute("aria-valuenow"));
    const next = { ArrowLeft: cur - 5, ArrowRight: cur + 5, Home: 0, End: 100 }[e.key];
    if (next !== undefined) { setPos(next); e.preventDefault(); }
  });
  return root;
}

// ---------- stepper ----------

/**
 * Render a progress stepper into `container` (see `.stepper` in css/base.css).
 * steps: [label,...]; current: 0-based index; done: Set of completed indexes.
 * Output: <ol class="stepper"><li class="is-done|is-current"><span class="stepper-num">01</span>
 * <span class="stepper-label">…</span></li>…</ol>. `compact` only adds a "compact" class for page CSS.
 */
export function renderStepper(container, steps, current, done = new Set(), { compact = false } = {}) {
  container.replaceChildren();
  container.classList.remove("stepper");
  container.classList.toggle("compact", compact);
  const items = steps.map((label, i) => {
    const complete = done.has(i) && i !== current;
    const li = h("li", { class: i === current ? "is-current" : complete ? "is-done" : null },
      h("span", { class: "stepper-num", "aria-hidden": "true", text: String(i + 1).padStart(2, "0") }),
      h("span", { class: "stepper-label", text: label }),
      h("span", { class: "sr-only", text: complete ? " (completed)" : i === current ? " (current step)" : "" }));
    if (i === current) li.setAttribute("aria-current", "step");
    return li;
  });
  container.append(h("ol", { class: "stepper" }, ...items));
}

// ---------- product photo picker (1-5 photos, one angle each) ----------

export const ANGLES = ["front", "side", "back", "worn", "detail"];

/**
 * Photo slots with preview, angle select and remove button.
 * `container` receives the slots; `fileInput` is a hidden <input type=file multiple>;
 * `addButton` opens it. Returns { photos, appendTo(form), reset() }.
 */
export function createPhotoSlots({ container, fileInput, addButton, max = 5, onChange = () => {}, onNotice = () => {} }) {
  const photos = []; // [{file, angle, url}]

  function render() {
    container.replaceChildren();
    photos.forEach((photo, i) => {
      const select = h("select", { "aria-label": `Angle for photo ${i + 1}` });
      for (const a of ANGLES) select.append(h("option", { value: a, text: categoryLabel(a) }));
      select.value = photo.angle;
      select.addEventListener("change", () => { photo.angle = select.value; });
      const remove = h("button", { type: "button", class: "btn btn-sm btn-danger", text: "Remove", "aria-label": `Remove photo ${i + 1}` });
      remove.addEventListener("click", () => { URL.revokeObjectURL(photo.url); photos.splice(i, 1); render(); onChange(); });
      container.append(h("div", { class: "photo-slot" },
        h("div", { class: "thumb-item" }, h("img", { src: photo.url, alt: `Photo ${i + 1} preview` })),
        h("div", { class: "slot-ctrl" }, select, remove)));
    });
    addButton.disabled = photos.length >= max;
  }

  addButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files).filter((f) => f.type.startsWith("image/"));
    const room = max - photos.length;
    const used = new Set(photos.map((p) => p.angle));
    for (const file of files.slice(0, room)) {
      const angle = ANGLES.find((a) => !used.has(a)) || "detail";
      used.add(angle);
      photos.push({ file, angle, url: URL.createObjectURL(file) });
    }
    onNotice(files.length > room ? `Only ${max} photos allowed. Extra photos were ignored.` : "");
    fileInput.value = "";
    render();
    onChange();
  });
  render();

  return {
    photos,
    appendTo(form) { for (const p of photos) { form.append("images", p.file); form.append("angles", p.angle); } },
    reset() { photos.forEach((p) => URL.revokeObjectURL(p.url)); photos.length = 0; render(); onChange(); },
  };
}
