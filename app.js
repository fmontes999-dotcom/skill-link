"use strict";

/* =====================================================================
   Skill-Link · aplicación web (Supabase + pagos con QR de Banco Pichincha)
   Modelo: comisión del 8% al 10% solo por ventas concretadas.
   ===================================================================== */

const CATEGORY_STYLE = {
  Comida: { emoji: "🥐", tone: "peach" },
  "Arte y regalos": { emoji: "🎨", tone: "lilac" },
  Servicios: { emoji: "✨", tone: "blue" },
  Bienestar: { emoji: "🌿", tone: "sage" },
};
const STATUS_LABELS = {
  pendiente: "Pendiente",
  aceptado: "Aceptado",
  completado: "Entregado",
  rechazado: "Rechazado",
  cancelado: "Cancelado",
};
const COMMISSION_STATUS = {
  pendiente: "Por pagar",
  en_revision: "En revisión",
  pagada: "Pagada",
  anulada: "Anulada",
};
const PAYMENT_STATUS = { en_revision: "En revisión", aprobado: "Aprobado", rechazado: "Rechazado" };
const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const PUCE_EMAIL = /@([a-z0-9-]+\.)*puce\.edu\.ec$/i;
const QR_PREFIX = "SKILLLINK|ENTREGA|";
const SCANNER_SRC = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
const FAVORITES_KEY = "skill-link-favorites-v2";

const config = window.SKILL_LINK_CONFIG || {};
const isConfigured = Boolean(config.supabaseUrl && config.supabaseAnonKey && window.supabase);

// El enlace del correo de acceso vuelve a la página con #access_token=... (o #error=... si expiró).
// Se lee antes de crear el cliente, porque Supabase limpia la URL al procesarla.
const AUTH_REDIRECT = (() => {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get("access_token")) return { ok: true };
  const code = params.get("error_code") || params.get("error");
  return code ? { ok: false, code } : null;
})();

const sb = isConfigured ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;

const state = {
  session: null,
  profile: null,
  settings: { commission_rate: 0.1, payment_qr_path: null, payment_holder: null },
  catalog: [],
  catalogLoaded: false,
  pickupPoints: [],
  category: "Todos",
  activeProduct: null,
  panelTab: "compras",
  pendingAction: null,
  loginEmail: "",
  scanner: null,
};
const panelData = { orders: new Map(), products: new Map(), pendingCommissions: 0, payments: new Map() };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {
  grid: $("#product-grid"),
  search: $("#search-input"),
  categories: $("#category-list"),
  count: $("#result-count"),
  empty: $("#empty-state"),
  homeView: $("#home-view"),
  panelView: $("#panel-view"),
  panelContent: $("#panel-content"),
  loginDialog: $("#login-dialog"),
  publishDialog: $("#publish-dialog"),
  orderDialog: $("#order-dialog"),
  sheetDialog: $("#sheet-dialog"),
  sheetContent: $("#sheet-content"),
};

/* ---------------------------------------------------------------------
   Utilidades
   --------------------------------------------------------------------- */

const money = new Intl.NumberFormat("es-EC", { style: "currency", currency: "USD" });

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatPrice(value) {
  return money.format(Number(value) || 0);
}

function formatDate(value, withTime = true) {
  if (!value) return "—";
  const options = withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" };
  return new Intl.DateTimeFormat("es-EC", options).format(new Date(value));
}

function ratePercent(rate = state.settings.commission_rate) {
  return `${Math.round(Number(rate) * 100)}%`;
}

function toCents(value) {
  return Math.round((Number(value) || 0) * 100);
}

function commissionFor(amount, rate = state.settings.commission_rate) {
  return Math.round(Number(amount) * Number(rate) * 100) / 100;
}

function sumMoney(rows, pick) {
  return rows.reduce((total, row) => total + toCents(pick(row)), 0) / 100;
}

function one(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function uid() {
  return state.session?.user?.id || null;
}

function displayName(profile) {
  return profile?.full_name?.trim() || profile?.email || "Usuario PUCE";
}

function randomId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function whatsappLink(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) digits = `593${digits.slice(1)}`;
  return `https://wa.me/${digits}`;
}

function toLocalInputValue(date) {
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function validateImage(file, maxBytes) {
  if (!IMAGE_TYPES[file.type]) throw new Error("La imagen debe ser JPG, PNG o WebP.");
  if (file.size > maxBytes) throw new Error(`La imagen supera ${Math.round(maxBytes / 1048576)} MB.`);
  return IMAGE_TYPES[file.type];
}

let toastTimer;
function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("toast-error", isError);
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), isError ? 5200 : 3600);
}

function errorMessage(error) {
  const message = error?.message || String(error || "");
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return "No hay conexión con el servidor. Revisa tu internet.";
  if (/JWT expired|session.*(expired|missing)/i.test(message)) return "Tu sesión expiró. Vuelve a ingresar.";
  if (/Database error saving new user/i.test(message)) return "Solo se permiten correos institucionales de la PUCE.";
  if (/rate limit|too many|security purposes/i.test(message)) return "Demasiados intentos. Espera unos minutos y vuelve a probar.";
  if (/row-level security/i.test(message)) return "No tienes permiso para realizar esta acción.";
  return message || "Ocurrió un error inesperado.";
}

async function withBusy(target, task) {
  const button = target.matches("button") ? target : target.querySelector("[type=submit]");
  if (button?.disabled) return undefined;
  if (button) {
    button.disabled = true;
    button.classList.add("is-busy");
  }
  try {
    return await task();
  } catch (error) {
    console.error(error);
    showToast(errorMessage(error), true);
    return undefined;
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("is-busy");
    }
  }
}

function requireConfigured() {
  if (isConfigured) return true;
  showToast("Falta conectar Supabase. Revisa el README para configurarlo.", true);
  return false;
}

const scriptPromises = new Map();
function loadScript(src) {
  if (!scriptPromises.has(src)) {
    scriptPromises.set(src, new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => {
        scriptPromises.delete(src);
        reject(new Error("No se pudo cargar el lector de QR."));
      };
      document.head.append(script);
    }));
  }
  return scriptPromises.get(src);
}

/* ---------------------------------------------------------------------
   Favoritos (solo en este navegador)
   --------------------------------------------------------------------- */

function getFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function toggleFavorite(productId) {
  const favorites = getFavorites();
  const updated = favorites.includes(productId)
    ? favorites.filter((id) => id !== productId)
    : [...favorites, productId];
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(updated));
  } catch {
    showToast("No se pudieron guardar tus favoritos en este navegador.", true);
  }
  renderProducts();
}

/* ---------------------------------------------------------------------
   Configuración, comisión y calculadora
   --------------------------------------------------------------------- */

async function loadSettings() {
  const { data, error } = await sb
    .from("platform_settings")
    .select("commission_rate, payment_qr_path, payment_holder")
    .maybeSingle();
  if (error) {
    console.error(error);
  } else if (data) {
    state.settings = { ...data, commission_rate: Number(data.commission_rate) };
  }
  applyRate();
}

async function loadPickupPoints() {
  const { data, error } = await sb.from("pickup_points").select("name, schedule").order("id");
  if (error) console.error(error);
  state.pickupPoints = data || [];
}

function applyRate() {
  $$("[data-rate]").forEach((element) => {
    element.textContent = ratePercent();
  });
  updateCalculator();
  updatePublishNet();
}

function updateCalculator() {
  const price = Math.max(0, Number($("#calc-price").value) || 0);
  const fee = commissionFor(price);
  $("#calc-fee").textContent = formatPrice(fee);
  $("#calc-net").textContent = formatPrice(price - fee);
}

function updatePublishNet() {
  const price = Number($("#publish-price").value);
  const box = $("#publish-net");
  if (!price || price <= 0) {
    box.textContent = `Comisión del ${ratePercent()} solo cuando vendes.`;
    return;
  }
  const fee = commissionFor(price);
  box.innerHTML = `Por cada venta recibes <strong>${formatPrice(price - fee)}</strong> · comisión ${formatPrice(fee)} (${ratePercent()})`;
}

/* ---------------------------------------------------------------------
   Catálogo
   --------------------------------------------------------------------- */

async function loadCatalog() {
  if (!state.catalogLoaded) els.count.textContent = "Cargando…";
  const { data, error } = await sb.rpc("get_catalog");
  if (error) {
    console.error(error);
    showToast(`No se pudo cargar el catálogo. ${errorMessage(error)}`, true);
  }
  state.catalog = error ? state.catalog : data || [];
  state.catalogLoaded = true;
  renderProducts();
}

function productImageUrl(path) {
  return path ? sb.storage.from("product-images").getPublicUrl(path).data.publicUrl : "";
}

function productCard(product, favorites) {
  const style = CATEGORY_STYLE[product.category] || { emoji: "✨", tone: "sage" };
  const id = escapeHtml(product.id);
  const isFavorite = favorites.includes(product.id);
  const isOwn = product.seller_id === uid();
  const rating = Number(product.reviews_count) > 0
    ? `★ ${Number(product.rating).toFixed(1)} · ${product.reviews_count}`
    : "Nuevo";
  const art = product.image_path
    ? `<img class="product-photo" src="${escapeHtml(productImageUrl(product.image_path))}" alt="" loading="lazy" />`
    : `<span class="product-emoji" aria-hidden="true">${style.emoji}</span>`;
  return `
    <article class="product-card">
      <div class="product-art tone-${style.tone}${product.image_path ? " has-photo" : ""}">
        <span class="product-tag">${escapeHtml(rating)}</span>
        <button class="favorite-button${isFavorite ? " favorited" : ""}" type="button" data-favorite="${id}" aria-label="${isFavorite ? "Quitar de" : "Añadir a"} favoritos" aria-pressed="${isFavorite}">${isFavorite ? "♥" : "♡"}</button>
        ${art}
      </div>
      <div class="product-info">
        <div class="product-meta">
          <span class="seller-line"><span class="verified" aria-label="Comunidad PUCE">✦</span>${escapeHtml(product.seller_name)}</span>
          <span>${product.pickup_point ? "Punto Link" : "Por coordinar"}</span>
        </div>
        <h3 title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</h3>
        <div class="card-bottom">
          <span class="price">${formatPrice(product.price)} <small>${product.category === "Servicios" ? "/ servicio" : "/ unidad"}</small></span>
          <button class="interest-button" type="button" data-order="${id}"${isOwn ? " disabled" : ""}>${isOwn ? "Es tuyo" : "Pedir ↗"}</button>
        </div>
      </div>
    </article>`;
}

function renderProducts() {
  if (!state.catalogLoaded) return;
  const query = els.search.value.trim().toLocaleLowerCase("es");
  const favorites = getFavorites();
  const filtered = state.catalog.filter((product) => {
    const matchesCategory = state.category === "Todos"
      || (state.category === "Favoritos" ? favorites.includes(product.id) : product.category === state.category);
    const searchable = `${product.name} ${product.category} ${product.seller_name} ${product.description}`.toLocaleLowerCase("es");
    return matchesCategory && searchable.includes(query);
  });
  const catalogIsEmpty = state.catalog.length === 0;
  els.count.textContent = `${filtered.length} ${filtered.length === 1 ? "emprendimiento" : "emprendimientos"}`;
  $("#empty-title").textContent = catalogIsEmpty
    ? "Aún no hay publicaciones"
    : state.category === "Favoritos" && !query ? "Todavía no tienes favoritos" : "No encontramos resultados";
  $("#empty-text").textContent = catalogIsEmpty
    ? "Sé la primera persona en publicar su emprendimiento."
    : "Prueba con otra búsqueda o categoría.";
  $("#reset-filters").classList.toggle("hidden", catalogIsEmpty);
  els.empty.classList.toggle("hidden", filtered.length > 0);
  els.grid.classList.toggle("hidden", filtered.length === 0);
  els.grid.innerHTML = filtered.map((product) => productCard(product, favorites)).join("");
}

function selectCategory(category) {
  state.category = category;
  els.categories.querySelectorAll(".category-chip").forEach((chip) => {
    chip.classList.toggle("selected", chip.dataset.category === category);
  });
  renderProducts();
}

/* ---------------------------------------------------------------------
   Sesión (enlace o código por correo institucional)
   --------------------------------------------------------------------- */

function loginErrorMessage(error) {
  const message = error?.message || String(error || "");
  if (/security purposes|after \d+ seconds/i.test(message)) return "Espera un minuto antes de pedir otro correo de acceso.";
  if (/rate limit|too many/i.test(message)) return "Se alcanzó el límite de correos de acceso por hora. Inténtalo más tarde.";
  if (/database error saving new user/i.test(message)) return "Solo pueden crear cuenta los correos @puce.edu.ec.";
  return message;
}

async function initAuth() {
  const { data } = await sb.auth.getSession();
  if (AUTH_REDIRECT) {
    // Quita los datos del enlace que puedan quedar en la barra de direcciones.
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.has("access_token") || params.has("error") || params.has("error_code") || location.hash === "#") {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }
  await setSession(data.session);
  if (AUTH_REDIRECT?.ok && data.session) {
    onSignedIn();
  } else if (AUTH_REDIRECT && !AUTH_REDIRECT.ok) {
    showToast(AUTH_REDIRECT.code === "otp_expired"
      ? "El enlace de acceso expiró o ya se usó. Pide uno nuevo."
      : "No se pudo ingresar con ese enlace. Pide uno nuevo.", true);
  }
  sb.auth.onAuthStateChange((event, session) => {
    // Se difiere para no llamar a Supabase dentro del callback (evita bloqueos).
    window.setTimeout(() => handleAuthChange(event, session), 0);
  });
}

async function handleAuthChange(event, session) {
  const previousUser = uid();
  const nextUser = session?.user?.id || null;
  if (previousUser === nextUser) {
    state.session = session;
    return;
  }
  await setSession(session);
  renderProducts();
  if (nextUser) {
    onSignedIn();
  } else if (location.hash.startsWith("#panel")) {
    location.hash = "";
  }
  route();
}

async function setSession(session) {
  state.session = session;
  state.profile = null;
  if (session) await loadProfile();
  updateHeader();
  refreshBadge();
}

async function loadProfile() {
  const { data, error } = await sb.from("profiles").select("*").eq("id", uid()).maybeSingle();
  if (error) console.error(error);
  state.profile = data || null;
}

function initials() {
  const source = state.profile?.full_name?.trim() || state.session?.user?.email || "SL";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return `${parts[0]?.[0] || "S"}${parts[1]?.[0] || ""}`.toUpperCase();
}

function updateHeader() {
  const loggedIn = Boolean(state.session);
  $("#open-login").classList.toggle("hidden", loggedIn);
  $("#open-panel").classList.toggle("hidden", !loggedIn);
  $("#avatar-initials").textContent = loggedIn ? initials() : "SL";
  $("#admin-tab").classList.toggle("hidden", state.profile?.role !== "admin");
}

async function refreshBadge() {
  const badge = $("#avatar-badge");
  if (!state.session) {
    badge.classList.add("hidden");
    return;
  }
  const { count, error } = await sb
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", uid())
    .eq("status", "pendiente");
  badge.classList.toggle("hidden", Boolean(error) || !count);
  $("#open-panel").setAttribute("aria-label", count ? `Abrir mi panel (${count} pedidos por responder)` : "Abrir mi panel");
}

function openLogin(reason, after) {
  if (!requireConfigured()) return;
  state.pendingAction = after || null;
  $("#login-reason").textContent = reason || "Te enviaremos un enlace de acceso a tu correo. No necesitas contraseña.";
  showLoginStep("email");
  if (!els.loginDialog.open) els.loginDialog.showModal();
}

function showLoginStep(step) {
  $("#login-email-form").classList.toggle("hidden", step !== "email");
  $("#login-code-form").classList.toggle("hidden", step !== "code");
}

function onSignedIn() {
  if (els.loginDialog.open) els.loginDialog.close();
  const pending = state.pendingAction;
  state.pendingAction = null;
  if (pending) {
    pending();
    return;
  }
  if (!state.profile?.full_name) {
    showToast("¡Bienvenido! Completa tu perfil para empezar.");
    location.hash = "#panel/perfil";
  } else {
    showToast(`¡Hola, ${state.profile.full_name.split(" ")[0]}!`);
  }
}

/* ---------------------------------------------------------------------
   Navegación: catálogo ↔ panel
   --------------------------------------------------------------------- */

const PANEL_TABS = {
  compras: renderPurchases,
  ventas: renderSales,
  publicaciones: renderListings,
  comisiones: renderCommissions,
  perfil: renderProfile,
  admin: renderAdmin,
};

function route() {
  const hash = location.hash;
  if (hash.startsWith("#panel")) {
    if (!isConfigured) {
      history.replaceState(null, "", location.pathname);
      showHome();
      requireConfigured();
      return;
    }
    if (!state.session) {
      const target = hash;
      history.replaceState(null, "", location.pathname);
      showHome();
      openLogin("Ingresa con tu correo PUCE para ver tu panel.", () => { location.hash = target; });
      return;
    }
    const tab = hash.split("/")[1] || state.panelTab;
    showPanel(PANEL_TABS[tab] ? tab : "compras");
    return;
  }
  showHome();
}

function showHome() {
  const wasHidden = els.homeView.classList.contains("hidden");
  els.homeView.classList.remove("hidden");
  els.panelView.classList.add("hidden");
  if (!wasHidden) return;
  const id = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : "";
  const target = id && /^[\w-]+$/.test(id) ? document.getElementById(id) : null;
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
}

function showPanel(tab) {
  if (tab === "admin" && state.profile?.role !== "admin") tab = "compras";
  const changed = state.panelTab !== tab || els.panelView.classList.contains("hidden");
  state.panelTab = tab;
  els.homeView.classList.add("hidden");
  els.panelView.classList.remove("hidden");
  $$(".panel-tab").forEach((link) => {
    const active = link.dataset.tab === tab;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  // En móvil las pestañas se desplazan: mantener visible la activa.
  const tabs = $("#panel-tabs");
  const activeTab = tabs.querySelector(".panel-tab.active");
  if (activeTab) tabs.scrollLeft = Math.max(0, activeTab.offsetLeft - (tabs.clientWidth - activeTab.offsetWidth) / 2);
  const firstName = state.profile?.full_name?.trim().split(" ")[0];
  $("#panel-greeting").textContent = firstName ? `Hola, ${firstName}` : "Hola";
  $("#panel-email").textContent = state.session.user.email;
  if (changed) window.scrollTo(0, 0);
  renderPanelTab();
}

let panelRenderToken = 0;
async function renderPanelTab() {
  const token = ++panelRenderToken;
  const tab = state.panelTab;
  if (!els.panelContent.dataset.tab || els.panelContent.dataset.tab !== tab) {
    els.panelContent.innerHTML = '<div class="panel-loading">Cargando…</div>';
  }
  try {
    const html = await PANEL_TABS[tab]();
    if (token !== panelRenderToken) return;
    els.panelContent.dataset.tab = tab;
    els.panelContent.innerHTML = html;
  } catch (error) {
    if (token !== panelRenderToken) return;
    console.error(error);
    els.panelContent.dataset.tab = "";
    els.panelContent.innerHTML = `
      <div class="panel-empty">
        <h3>No se pudo cargar esta sección</h3>
        <p>${escapeHtml(errorMessage(error))}</p>
        <button class="button button-outline" type="button" data-action="reload">Reintentar</button>
      </div>`;
  }
}

function refreshPanel() {
  if (!els.panelView.classList.contains("hidden")) renderPanelTab();
  refreshBadge();
}

function emptyPanel(title, text, actionHtml = "") {
  return `<div class="panel-empty"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${actionHtml}</div>`;
}

function sectionHead(title, text, actionHtml = "") {
  return `
    <div class="panel-section-head">
      <div><h2>${escapeHtml(title)}</h2>${text ? `<p>${escapeHtml(text)}</p>` : ""}</div>
      ${actionHtml}
    </div>`;
}

function statCard(label, value, hint = "", tone = "") {
  return `<div class="stat-card${tone ? ` stat-${tone}` : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</div>`;
}

/* ---------------------------------------------------------------------
   Panel · pedidos (compras y ventas)
   --------------------------------------------------------------------- */

function cacheOrders(orders) {
  panelData.orders.clear();
  orders.forEach((order) => panelData.orders.set(order.id, order));
}

function contactLine(label, profile) {
  if (!profile) return "";
  const whatsapp = whatsappLink(profile.phone);
  const links = [
    profile.email ? `<a href="mailto:${escapeHtml(profile.email)}">Correo</a>` : "",
    whatsapp ? `<a href="${escapeHtml(whatsapp)}" target="_blank" rel="noopener">WhatsApp</a>` : "",
  ].filter(Boolean).join(" · ");
  return `<p class="order-contact">${escapeHtml(label)}: <strong>${escapeHtml(displayName(profile))}</strong>${links ? ` · ${links}` : ""}</p>`;
}

function orderCard(order, role) {
  const isBuyer = role === "buyer";
  const id = escapeHtml(order.id);
  const commission = one(order.commission);
  const review = one(order.review);
  const details = [
    ["Total", formatPrice(order.total)],
    ["Cantidad", `${order.quantity} × ${formatPrice(order.unit_price)}`],
  ];
  if (order.pickup_point) details.push(["Entrega", order.pickup_point]);
  if (order.meeting_at) details.push(["Fecha", formatDate(order.meeting_at)]);
  if (!isBuyer && commission) details.push([`Comisión (${ratePercent(commission.rate)})`, formatPrice(commission.amount)]);

  let note = "";
  let noteTone = "";
  const actions = [];
  const paid = Boolean(order.payment_reference);

  if (order.status === "pendiente") {
    if (isBuyer) {
      note = "Esperando a que quien emprende acepte tu pedido.";
      actions.push(`<button class="button button-ghost" type="button" data-action="cancel" data-id="${id}">Cancelar pedido</button>`);
    } else {
      note = "Acepta el pedido y elige el Punto Link y la hora de entrega.";
      noteTone = "attention";
      actions.push(`<button class="button button-dark" type="button" data-action="accept" data-id="${id}">Aceptar pedido</button>`);
      actions.push(`<button class="button button-ghost" type="button" data-action="reject" data-id="${id}">Rechazar</button>`);
    }
  } else if (order.status === "aceptado") {
    if (isBuyer) {
      note = paid
        ? `Pago reportado · comprobante ${order.payment_reference}. Cuando recibas tu pedido, muestra tu QR de entrega.`
        : `Paga ${formatPrice(order.total)} con el QR de Banco Pichincha del emprendedor (antes o en el Punto Link).`;
      noteTone = paid ? "ok" : "attention";
      actions.push(`<button class="button ${paid ? "button-outline" : "button-dark"}" type="button" data-action="pay" data-id="${id}">${paid ? "Ver QR de pago" : "Pagar con QR"}</button>`);
      actions.push(`<button class="button ${paid ? "button-dark" : "button-outline"}" type="button" data-action="delivery-qr" data-id="${id}">Mostrar QR de entrega</button>`);
      actions.push(`<button class="button button-ghost" type="button" data-action="cancel" data-id="${id}">Cancelar</button>`);
    } else {
      note = paid
        ? `El comprador reportó el pago · comprobante ${order.payment_reference}. Verifícalo en tu app de Banco Pichincha antes de entregar.`
        : `Aún no se reporta el pago. Verifica en tu app de Banco Pichincha que recibiste ${formatPrice(order.total)} antes de entregar.`;
      noteTone = paid ? "ok" : "attention";
      actions.push(`<button class="button button-dark" type="button" data-action="scan" data-id="${id}">Escanear QR de entrega</button>`);
      actions.push(`<button class="button button-ghost" type="button" data-action="cancel" data-id="${id}">Cancelar</button>`);
    }
  } else if (order.status === "completado") {
    noteTone = "ok";
    if (isBuyer) {
      note = `Compra concretada el ${formatDate(order.completed_at)}.`;
      if (review) note += ` Tu calificación: ${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}`;
      else actions.push(`<button class="button button-outline" type="button" data-action="review" data-id="${id}">Calificar compra</button>`);
    } else {
      note = `Venta registrada el ${formatDate(order.completed_at)}.`;
      if (commission) note += ` Comisión: ${formatPrice(commission.amount)} · ${COMMISSION_STATUS[commission.status] || commission.status}.`;
    }
  } else {
    note = order.closed_reason || STATUS_LABELS[order.status];
  }

  return `
    <article class="order-card">
      <div class="order-top">
        <div>
          <span class="order-code">Pedido #${escapeHtml(order.code)} · ${escapeHtml(formatDate(order.created_at, false))}</span>
          <h3>${escapeHtml(order.product_name)}</h3>
          ${contactLine(isBuyer ? "Emprendedor" : "Comprador", isBuyer ? order.seller : order.buyer)}
        </div>
        <span class="status-chip status-${escapeHtml(order.status)}">${escapeHtml(STATUS_LABELS[order.status] || order.status)}</span>
      </div>
      <dl class="order-details">
        ${details.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
      </dl>
      ${order.message ? `<p class="order-message">“${escapeHtml(order.message)}”</p>` : ""}
      ${note ? `<p class="order-note${noteTone ? ` note-${noteTone}` : ""}">${escapeHtml(note)}</p>` : ""}
      ${actions.length ? `<div class="order-actions">${actions.join("")}</div>` : ""}
    </article>`;
}

function groupOrders(orders, role) {
  const active = orders.filter((order) => ["pendiente", "aceptado"].includes(order.status));
  const history = orders.filter((order) => !["pendiente", "aceptado"].includes(order.status));
  let html = "";
  if (active.length) {
    html += `<h3 class="list-title">En curso · ${active.length}</h3><div class="order-list">${active.map((order) => orderCard(order, role)).join("")}</div>`;
  }
  if (history.length) {
    html += `<h3 class="list-title">Historial · ${history.length}</h3><div class="order-list">${history.map((order) => orderCard(order, role)).join("")}</div>`;
  }
  return html;
}

async function renderPurchases() {
  const { data, error } = await sb
    .from("orders")
    .select("*, seller:profiles!orders_seller_id_fkey(full_name, email, phone, payment_qr_path, payment_holder), review:reviews(rating)")
    .eq("buyer_id", uid())
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  cacheOrders(data);
  const head = sectionHead("Mis compras", "Paga con el QR de Banco Pichincha del emprendedor y muestra tu QR de entrega al recibir.");
  if (!data.length) {
    return head + emptyPanel("Aún no has hecho pedidos", "Explora el catálogo y pide algo hecho por estudiantes de la PUCE.", '<a class="button button-dark" href="#explorar">Explorar catálogo</a>');
  }
  return head + groupOrders(data, "buyer");
}

async function renderSales() {
  const { data, error } = await sb
    .from("orders")
    .select("*, buyer:profiles!orders_buyer_id_fkey(full_name, email, phone), commission:commissions(amount, rate, status)")
    .eq("seller_id", uid())
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  cacheOrders(data);
  const completed = data.filter((order) => order.status === "completado");
  const stats = `
    <div class="stat-grid">
      ${statCard("Por responder", String(data.filter((order) => order.status === "pendiente").length), "", "attention")}
      ${statCard("Por entregar", String(data.filter((order) => order.status === "aceptado").length))}
      ${statCard("Ventas registradas", String(completed.length), formatPrice(sumMoney(completed, (order) => order.total)))}
    </div>`;
  const warning = state.profile?.payment_qr_path
    ? ""
    : '<p class="order-note note-attention">Aún no subiste tu QR de cobro de Banco Pichincha. <a href="#panel/perfil">Súbelo aquí</a> para que te puedan pagar.</p>';
  const head = sectionHead("Mis ventas", "Al entregar, escanea el QR del comprador: así la venta queda registrada.");
  if (!data.length) {
    return head + warning + emptyPanel("Todavía no tienes pedidos", "Cuando alguien pida uno de tus productos, aparecerá aquí.", '<button class="button button-dark" type="button" data-action="new-listing">Publicar algo</button>');
  }
  return head + stats + warning + groupOrders(data, "seller");
}

/* ---------------------------------------------------------------------
   Panel · publicaciones
   --------------------------------------------------------------------- */

async function renderListings() {
  const { data, error } = await sb
    .from("products")
    .select("*")
    .eq("seller_id", uid())
    .order("created_at", { ascending: false });
  if (error) throw error;
  panelData.products.clear();
  data.forEach((product) => panelData.products.set(product.id, product));
  const head = sectionHead(
    "Mis publicaciones",
    `Publicar es gratis. Solo se genera una comisión del ${ratePercent()} por venta concretada.`,
    '<button class="button button-dark" type="button" data-action="new-listing">＋ Nueva publicación</button>',
  );
  const ready = state.profile?.full_name && state.profile?.payment_qr_path;
  const warning = ready
    ? ""
    : '<p class="order-note note-attention">Para publicar necesitas tu nombre y tu QR de cobro de Banco Pichincha. <a href="#panel/perfil">Completa tu perfil</a>.</p>';
  if (!data.length) {
    return head + warning + emptyPanel("Aún no publicaste nada", "Muestra tus productos o servicios a toda la comunidad PUCE.");
  }
  const rows = data.map((product) => {
    const style = CATEGORY_STYLE[product.category] || { emoji: "✨", tone: "sage" };
    const id = escapeHtml(product.id);
    const thumb = product.image_path
      ? `<img src="${escapeHtml(productImageUrl(product.image_path))}" alt="" loading="lazy" />`
      : `<span aria-hidden="true">${style.emoji}</span>`;
    return `
      <article class="listing-row">
        <div class="listing-thumb tone-${style.tone}">${thumb}</div>
        <div class="listing-info">
          <h3>${escapeHtml(product.name)}</h3>
          <p>${escapeHtml(product.category)} · ${formatPrice(product.price)} · recibes ${formatPrice(product.price - commissionFor(product.price))}</p>
        </div>
        <span class="status-chip ${product.active ? "status-completado" : "status-cancelado"}">${product.active ? "Activa" : "Pausada"}</span>
        <div class="listing-actions">
          <button class="button button-outline" type="button" data-action="toggle-listing" data-id="${id}">${product.active ? "Pausar" : "Activar"}</button>
          <button class="button button-ghost" type="button" data-action="delete-listing" data-id="${id}">Eliminar</button>
        </div>
      </article>`;
  }).join("");
  return head + warning + `<div class="listing-list">${rows}</div>`;
}

/* ---------------------------------------------------------------------
   Panel · comisiones del emprendedor
   --------------------------------------------------------------------- */

async function renderCommissions() {
  const [commissionsResult, paymentsResult] = await Promise.all([
    sb.from("commissions")
      .select("*, pedido:orders(code, product_name, completed_at)")
      .eq("seller_id", uid())
      .order("created_at", { ascending: false })
      .limit(300),
    sb.from("commission_payments")
      .select("*")
      .eq("seller_id", uid())
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (commissionsResult.error) throw commissionsResult.error;
  if (paymentsResult.error) throw paymentsResult.error;
  const commissions = commissionsResult.data;
  const payments = paymentsResult.data;
  const valid = commissions.filter((row) => row.status !== "anulada");
  const byStatus = (status) => sumMoney(commissions.filter((row) => row.status === status), (row) => row.amount);
  const pending = byStatus("pendiente");
  panelData.pendingCommissions = pending;

  const head = sectionHead("Comisiones", `Sin mensualidades ni recargas: solo el ${ratePercent()} de cada venta concretada desde Skill-Link.`);
  const stats = `
    <div class="stat-grid">
      ${statCard("Ventas registradas", String(valid.length), formatPrice(sumMoney(valid, (row) => row.sale_amount)))}
      ${statCard("Comisiones generadas", formatPrice(sumMoney(valid, (row) => row.amount)))}
      ${statCard("Por pagar", formatPrice(pending), "", pending > 0 ? "attention" : "")}
      ${statCard("En revisión", formatPrice(byStatus("en_revision")))}
      ${statCard("Pagadas", formatPrice(byStatus("pagada")), "", "ok")}
    </div>`;
  const payBox = pending > 0
    ? `<div class="pay-box"><div><strong>Tienes ${formatPrice(pending)} en comisiones por pagar.</strong><p>Págalas escaneando el QR de Skill-Link desde tu app de Banco Pichincha y reporta el comprobante.</p></div><button class="button button-dark" type="button" data-action="pay-commissions">Pagar con QR</button></div>`
    : '<div class="pay-box pay-box-ok"><strong>Estás al día con tus comisiones.</strong></div>';

  if (!commissions.length) {
    return head + stats + emptyPanel("Aún no tienes ventas registradas", "La comisión se genera solo cuando escaneas el QR de entrega de una venta.");
  }

  const commissionRows = commissions.map((row) => {
    const pedido = one(row.pedido);
    return `
      <tr>
        <td data-label="Fecha">${escapeHtml(formatDate(row.created_at, false))}</td>
        <td data-label="Pedido">#${escapeHtml(pedido?.code || "—")} · ${escapeHtml(pedido?.product_name || "")}</td>
        <td data-label="Venta">${formatPrice(row.sale_amount)}</td>
        <td data-label="%">${ratePercent(row.rate)}</td>
        <td data-label="Comisión"><strong>${formatPrice(row.amount)}</strong></td>
        <td data-label="Estado"><span class="status-chip commission-${escapeHtml(row.status)}">${escapeHtml(COMMISSION_STATUS[row.status] || row.status)}</span>${row.void_reason ? `<small class="cell-note">${escapeHtml(row.void_reason)}</small>` : ""}</td>
      </tr>`;
  }).join("");

  const paymentRows = payments.map((row) => `
      <tr>
        <td data-label="Fecha">${escapeHtml(formatDate(row.created_at))}</td>
        <td data-label="Monto"><strong>${formatPrice(row.amount)}</strong></td>
        <td data-label="Comprobante">${escapeHtml(row.reference)}</td>
        <td data-label="Estado"><span class="status-chip payment-${escapeHtml(row.status)}">${escapeHtml(PAYMENT_STATUS[row.status] || row.status)}</span>${row.review_note ? `<small class="cell-note">${escapeHtml(row.review_note)}</small>` : ""}</td>
      </tr>`).join("");

  return head + stats + payBox + `
    <h3 class="list-title">Detalle por venta</h3>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Fecha</th><th>Pedido</th><th>Venta</th><th>%</th><th>Comisión</th><th>Estado</th></tr></thead>
      <tbody>${commissionRows}</tbody>
    </table></div>
    ${payments.length ? `
      <h3 class="list-title">Pagos realizados a Skill-Link</h3>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Fecha</th><th>Monto</th><th>Comprobante</th><th>Estado</th></tr></thead>
        <tbody>${paymentRows}</tbody>
      </table></div>` : ""}`;
}

/* ---------------------------------------------------------------------
   Panel · perfil y QR de cobro
   --------------------------------------------------------------------- */

async function signedQrUrl(path, options) {
  if (!path) return "";
  const { data, error } = await sb.storage.from("payment-qr").createSignedUrl(path, 900, options);
  if (error) {
    console.error(error);
    return "";
  }
  return data.signedUrl;
}

async function renderProfile() {
  await loadProfile();
  updateHeader();
  const profile = state.profile;
  if (!profile) {
    return emptyPanel("No encontramos tu perfil", "Cierra sesión y vuelve a ingresar. Si el problema sigue, contacta a soporte.");
  }
  const qrUrl = await signedQrUrl(profile.payment_qr_path);
  return sectionHead("Perfil y QR de cobro", "Tus datos se muestran solo a las personas con las que tienes un pedido.") + `
    <form class="panel-form" id="profile-form">
      <div class="panel-form-grid">
        <div class="panel-card">
          <h3>Tus datos</h3>
          <label>Nombre completo<input name="full_name" required minlength="3" maxlength="60" value="${escapeHtml(profile.full_name)}" placeholder="Ej. Camila Ajila" autocomplete="name" /></label>
          <label>Correo institucional<input value="${escapeHtml(profile.email)}" disabled /></label>
          <label>WhatsApp (opcional)<input name="phone" maxlength="16" pattern="[0-9+ ]{7,16}" value="${escapeHtml(profile.phone || "")}" placeholder="0991234567" inputmode="tel" autocomplete="tel" /></label>
        </div>
        <div class="panel-card">
          <h3>QR de cobro · Banco Pichincha</h3>
          <p class="help-text">Lo necesitas para vender. Los compradores lo escanean desde su app para pagarte directamente.</p>
          <div class="qr-preview">${qrUrl ? `<img src="${escapeHtml(qrUrl)}" alt="Tu QR de cobro" />` : "<span>Sin QR todavía</span>"}</div>
          <label>${profile.payment_qr_path ? "Reemplazar imagen del QR" : "Imagen de tu QR (PNG, JPG o WebP · máx. 2 MB)"}<input name="qr" type="file" accept="image/jpeg,image/png,image/webp" /></label>
          <label>Titular de la cuenta<input name="holder" maxlength="60" value="${escapeHtml(profile.payment_holder || "")}" placeholder="Nombre que aparece al pagar" /></label>
          <details class="help-details">
            <summary>¿Cómo obtengo mi QR?</summary>
            <ol>
              <li>Abre tu app de Banco Pichincha (Banca Móvil o DeUna).</li>
              <li>Busca la opción para <strong>cobrar con QR</strong> y genera tu código.</li>
              <li>Guarda la imagen (captura de pantalla recortada) y súbela aquí.</li>
              <li>Escribe el titular tal como aparece al pagar, para que el comprador pueda verificarlo.</li>
            </ol>
          </details>
        </div>
      </div>
      <button class="button button-dark" type="submit">Guardar perfil <span>↗</span></button>
    </form>`;
}

async function saveProfile(form) {
  const values = new FormData(form);
  const fullName = String(values.get("full_name") || "").trim().replace(/\s+/g, " ");
  const phone = String(values.get("phone") || "").trim();
  const holder = String(values.get("holder") || "").trim();
  if (fullName.length < 3) throw new Error("Escribe tu nombre completo.");
  if (phone && !/^[0-9+ ]{7,16}$/.test(phone)) throw new Error("El número de WhatsApp no es válido.");
  const update = { full_name: fullName, phone: phone || null, payment_holder: holder || null };
  const file = values.get("qr");
  const oldPath = state.profile?.payment_qr_path;
  let newPath = null;
  if (file && file.size) {
    const extension = validateImage(file, 2 * 1048576);
    newPath = `${uid()}/qr-${Date.now()}.${extension}`;
    const { error } = await sb.storage.from("payment-qr").upload(newPath, file, { contentType: file.type });
    if (error) throw error;
    update.payment_qr_path = newPath;
  }
  const { data, error } = await sb.from("profiles").update(update).eq("id", uid()).select().maybeSingle();
  if (error || !data) {
    if (newPath) await sb.storage.from("payment-qr").remove([newPath]);
    throw error || new Error("No se pudo guardar tu perfil.");
  }
  if (newPath && oldPath && oldPath !== newPath) sb.storage.from("payment-qr").remove([oldPath]);
  state.profile = data;
  updateHeader();
  showToast(data.payment_qr_path ? "Perfil guardado. ¡Ya puedes publicar!" : "Perfil guardado. Sube tu QR de cobro para poder vender.");
  showPanel("perfil");
}

/* ---------------------------------------------------------------------
   Panel · administración
   --------------------------------------------------------------------- */

async function renderAdmin() {
  const [settingsResult, paymentsResult, commissionsResult] = await Promise.all([
    sb.from("platform_settings").select("*").maybeSingle(),
    sb.from("commission_payments")
      .select("*, seller:profiles!commission_payments_seller_id_fkey(full_name, email)")
      .order("created_at", { ascending: false })
      .limit(100),
    sb.from("commissions")
      .select("*, seller:profiles!commissions_seller_id_fkey(full_name, email), pedido:orders(code, product_name)")
      .order("created_at", { ascending: false })
      .limit(300),
  ]);
  if (settingsResult.error) throw settingsResult.error;
  if (paymentsResult.error) throw paymentsResult.error;
  if (commissionsResult.error) throw commissionsResult.error;
  const settings = settingsResult.data || {};
  const payments = paymentsResult.data;
  const commissions = commissionsResult.data;
  panelData.payments.clear();
  payments.forEach((payment) => panelData.payments.set(payment.id, payment));

  const valid = commissions.filter((row) => row.status !== "anulada");
  const byStatus = (...statuses) => sumMoney(commissions.filter((row) => statuses.includes(row.status)), (row) => row.amount);
  const qrUrl = await signedQrUrl(settings.payment_qr_path);
  const currentRate = Number(settings.commission_rate || 0.1).toFixed(2);
  const rateOptions = ["0.08", "0.09", "0.10"]
    .map((value) => `<option value="${value}"${value === currentRate ? " selected" : ""}>${Math.round(Number(value) * 100)}%</option>`)
    .join("");

  const pendingPayments = payments.filter((row) => row.status === "en_revision");
  const paymentCards = pendingPayments.map((row) => `
      <article class="review-row">
        <div>
          <strong>${formatPrice(row.amount)}</strong> · comprobante <strong>${escapeHtml(row.reference)}</strong>
          <p>${escapeHtml(displayName(row.seller))} · ${escapeHtml(row.seller?.email || "")} · ${escapeHtml(formatDate(row.created_at))}</p>
        </div>
        <div class="listing-actions">
          <button class="button button-dark" type="button" data-action="approve-payment" data-id="${escapeHtml(row.id)}">Aprobar</button>
          <button class="button button-ghost" type="button" data-action="reject-payment" data-id="${escapeHtml(row.id)}">Rechazar</button>
        </div>
      </article>`).join("");

  const commissionRows = commissions.slice(0, 100).map((row) => {
    const pedido = one(row.pedido);
    const canVoid = ["pendiente", "pagada"].includes(row.status);
    return `
      <tr>
        <td data-label="Fecha">${escapeHtml(formatDate(row.created_at, false))}</td>
        <td data-label="Emprendedor">${escapeHtml(displayName(row.seller))}</td>
        <td data-label="Pedido">#${escapeHtml(pedido?.code || "—")} · ${escapeHtml(pedido?.product_name || "")}</td>
        <td data-label="Venta">${formatPrice(row.sale_amount)}</td>
        <td data-label="Comisión"><strong>${formatPrice(row.amount)}</strong> (${ratePercent(row.rate)})</td>
        <td data-label="Estado"><span class="status-chip commission-${escapeHtml(row.status)}">${escapeHtml(COMMISSION_STATUS[row.status] || row.status)}</span></td>
        <td data-label="">${canVoid ? `<button class="text-button" type="button" data-action="void-commission" data-id="${escapeHtml(row.id)}">Anular</button>` : ""}</td>
      </tr>`;
  }).join("");

  return sectionHead("Administración", "Configura la comisión y el QR de Skill-Link, y revisa los pagos de comisiones.") + `
    <div class="stat-grid">
      ${statCard("Ventas registradas", String(valid.length), formatPrice(sumMoney(valid, (row) => row.sale_amount)))}
      ${statCard("Comisiones generadas", formatPrice(sumMoney(valid, (row) => row.amount)))}
      ${statCard("Cobradas", formatPrice(byStatus("pagada")), "", "ok")}
      ${statCard("Por cobrar", formatPrice(byStatus("pendiente", "en_revision")), "", "attention")}
    </div>

    <form class="panel-form" id="admin-settings-form">
      <div class="panel-form-grid">
        <div class="panel-card">
          <h3>Comisión por venta concretada</h3>
          <p class="help-text">Rango aprobado en el modelo de negocio: 8% a 10%. Se aplica a las ventas que se registren desde ahora.</p>
          <label>Porcentaje<select name="rate">${rateOptions}</select></label>
          <label>Titular de la cuenta de Skill-Link<input name="holder" maxlength="60" value="${escapeHtml(settings.payment_holder || "")}" placeholder="Nombre que aparece al pagar" /></label>
        </div>
        <div class="panel-card">
          <h3>QR de cobro de Skill-Link · Banco Pichincha</h3>
          <p class="help-text">Los emprendedores lo escanean para pagar sus comisiones.</p>
          <div class="qr-preview">${qrUrl ? `<img src="${escapeHtml(qrUrl)}" alt="QR de cobro de Skill-Link" />` : "<span>Sin QR todavía</span>"}</div>
          <label>Subir o reemplazar QR<input name="qr" type="file" accept="image/jpeg,image/png,image/webp" /></label>
        </div>
      </div>
      <button class="button button-dark" type="submit">Guardar configuración</button>
    </form>

    <h3 class="list-title">Pagos de comisiones por revisar · ${pendingPayments.length}</h3>
    ${pendingPayments.length ? `<div class="review-list">${paymentCards}</div>` : '<p class="muted-line">No hay pagos pendientes de revisión.</p>'}

    <h3 class="list-title">Comisiones recientes</h3>
    ${commissions.length ? `
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Fecha</th><th>Emprendedor</th><th>Pedido</th><th>Venta</th><th>Comisión</th><th>Estado</th><th></th></tr></thead>
        <tbody>${commissionRows}</tbody>
      </table></div>` : '<p class="muted-line">Todavía no hay ventas registradas.</p>'}`;
}

async function saveAdminSettings(form) {
  const values = new FormData(form);
  const rate = Number(values.get("rate"));
  if (![0.08, 0.09, 0.1].includes(rate)) throw new Error("La comisión debe estar entre 8% y 10%.");
  const update = {
    commission_rate: rate,
    payment_holder: String(values.get("holder") || "").trim() || null,
    updated_at: new Date().toISOString(),
  };
  const file = values.get("qr");
  const oldPath = state.settings.payment_qr_path;
  let newPath = null;
  if (file && file.size) {
    const extension = validateImage(file, 2 * 1048576);
    newPath = `platform/qr-${Date.now()}.${extension}`;
    const { error } = await sb.storage.from("payment-qr").upload(newPath, file, { contentType: file.type });
    if (error) throw error;
    update.payment_qr_path = newPath;
  }
  const { data, error } = await sb.from("platform_settings").update(update).eq("id", true).select();
  if (error || !data?.length) {
    if (newPath) await sb.storage.from("payment-qr").remove([newPath]);
    throw error || new Error("No tienes permisos de administrador.");
  }
  if (newPath && oldPath && oldPath !== newPath) sb.storage.from("payment-qr").remove([oldPath]);
  await loadSettings();
  showToast("Configuración guardada.");
  renderPanelTab();
}

/* ---------------------------------------------------------------------
   Diálogo genérico (hojas de acción)
   --------------------------------------------------------------------- */

function openSheet(html) {
  stopScanner();
  els.sheetContent.innerHTML = `<button class="dialog-close" type="button" data-close aria-label="Cerrar">×</button>${html}`;
  if (!els.sheetDialog.open) els.sheetDialog.showModal();
  return els.sheetContent;
}

function closeSheet() {
  stopScanner();
  if (els.sheetDialog.open) els.sheetDialog.close();
}

function renderQr(container, text) {
  if (!window.QRCode) {
    container.innerHTML = "<span>No se pudo generar el QR. Usa el código manual.</span>";
    return;
  }
  container.innerHTML = "";
  // eslint-disable-next-line no-new
  new window.QRCode(container, {
    text,
    width: 220,
    height: 220,
    colorDark: "#1f2a22",
    colorLight: "#ffffff",
    correctLevel: window.QRCode.CorrectLevel.M,
  });
}

/* Emprendedor: aceptar pedido (Punto Link + hora). */
function openAcceptSheet(order) {
  const options = state.pickupPoints
    .map((point) => `<option value="${escapeHtml(point.name)}">${escapeHtml(point.name)} · ${escapeHtml(point.schedule)}</option>`)
    .join("");
  const sheet = openSheet(`
    <div class="eyebrow eyebrow-green">ACEPTAR PEDIDO #${escapeHtml(order.code)}</div>
    <h2>¿Dónde y cuándo entregas?</h2>
    <p class="dialog-description">${escapeHtml(order.product_name)} × ${order.quantity} · ${formatPrice(order.total)}</p>
    <form id="accept-form">
      <label>Punto Link
        <select name="point" required>${options}<option value="__other">Otro lugar acordado…</option></select>
      </label>
      <label class="${options ? "hidden" : ""}" id="other-point">Lugar acordado<input name="other" maxlength="120" placeholder="Ej. Entrada de la Facultad de Economía" /></label>
      <label>Fecha y hora<input name="when" type="datetime-local" required min="${toLocalInputValue(new Date())}" /></label>
      <button class="button button-dark dialog-submit" type="submit">Aceptar pedido <span>↗</span></button>
      <p class="form-note">El comprador verá tu QR de cobro de Banco Pichincha para pagarte.</p>
    </form>`);
  const form = $("#accept-form", sheet);
  const select = form.elements.point;
  const syncOther = () => $("#other-point", sheet).classList.toggle("hidden", select.value !== "__other");
  select.addEventListener("change", syncOther);
  syncOther();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy(form, async () => {
      const point = select.value === "__other" ? form.elements.other.value.trim() : select.value;
      if (!point) throw new Error("Escribe el lugar de entrega acordado.");
      const when = new Date(form.elements.when.value);
      if (Number.isNaN(when.getTime())) throw new Error("Indica una fecha y hora válidas.");
      const { error } = await sb.rpc("respond_order", {
        p_order_id: order.id,
        p_accept: true,
        p_pickup_point: point,
        p_meeting_at: when.toISOString(),
      });
      if (error) throw error;
      closeSheet();
      showToast(`Pedido #${order.code} aceptado. El comprador ya puede pagarte con tu QR.`);
      refreshPanel();
    });
  });
}

/* Comprador: pagar con el QR de Banco Pichincha del emprendedor. */
async function openPaySheet(order) {
  const seller = order.seller;
  if (!seller?.payment_qr_path) {
    throw new Error("Este emprendedor aún no tiene QR de cobro. Escríbele para coordinar el pago.");
  }
  const [viewUrl, downloadUrl] = await Promise.all([
    signedQrUrl(seller.payment_qr_path),
    signedQrUrl(seller.payment_qr_path, { download: `QR-pago-${order.code}.png` }),
  ]);
  if (!viewUrl) throw new Error("No se pudo cargar el QR de cobro. Intenta de nuevo.");
  const holder = seller.payment_holder || displayName(seller);
  const sheet = openSheet(`
    <div class="eyebrow eyebrow-green">PAGO CON QR · BANCO PICHINCHA</div>
    <h2>Paga ${formatPrice(order.total)}</h2>
    <p class="dialog-description">Pedido #${escapeHtml(order.code)} · ${escapeHtml(order.product_name)}<br />Titular: <strong>${escapeHtml(holder)}</strong></p>
    <div class="qr-frame"><img src="${escapeHtml(viewUrl)}" alt="QR de cobro de Banco Pichincha de ${escapeHtml(holder)}" /></div>
    ${downloadUrl ? `<a class="text-button qr-download" href="${escapeHtml(downloadUrl)}">¿Estás en el mismo celular? Descarga la imagen del QR</a>` : ""}
    <ol class="mini-steps">
      <li>Abre tu app de Banco Pichincha (Banca Móvil o DeUna) y elige pagar con QR.</li>
      <li>Escanea este código y verifica que el titular sea <strong>${escapeHtml(holder)}</strong>.</li>
      <li>Paga exactamente <strong>${formatPrice(order.total)}</strong> y copia aquí el número de comprobante.</li>
    </ol>
    <form id="pay-form">
      <label>Número de comprobante<input name="reference" required minlength="3" maxlength="40" value="${escapeHtml(order.payment_reference || "")}" placeholder="Ej. 123456789" autocomplete="off" /></label>
      <button class="button button-dark dialog-submit" type="submit">${order.payment_reference ? "Actualizar comprobante" : "Ya pagué"} <span>↗</span></button>
      <p class="form-note">¿Prefieres pagar en el Punto Link? Escanea este mismo QR al momento de la entrega.</p>
    </form>`);
  const form = $("#pay-form", sheet);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy(form, async () => {
      const { error } = await sb.rpc("report_payment", {
        p_order_id: order.id,
        p_reference: form.elements.reference.value.trim(),
      });
      if (error) throw error;
      closeSheet();
      showToast("Pago reportado. Cuando recibas tu pedido, muestra tu QR de entrega.");
      refreshPanel();
    });
  });
}

/* Comprador: QR de entrega (lo escanea el emprendedor en el Punto Link). */
async function openDeliveryQrSheet(order) {
  const { data, error } = await sb.from("order_delivery_codes").select("code").eq("order_id", order.id).single();
  if (error) throw error;
  const sheet = openSheet(`
    <div class="eyebrow eyebrow-green">QR DE ENTREGA · PEDIDO #${escapeHtml(order.code)}</div>
    <h2>Muéstralo al recibir tu pedido</h2>
    <p class="dialog-description">Enséñalo solo cuando tengas el pedido en tus manos. Al escanearlo, el emprendedor confirma que recibió tu pago y que te entregó el pedido.</p>
    <div class="qr-frame" id="delivery-qr"></div>
    <div class="delivery-code"><span>Código manual</span><strong>${escapeHtml(data.code)}</strong></div>
    <p class="form-note">${escapeHtml(order.pickup_point || "Lugar por coordinar")} · ${escapeHtml(formatDate(order.meeting_at))}</p>`);
  renderQr($("#delivery-qr", sheet), `${QR_PREFIX}${order.id}|${data.code}`);
}

/* Emprendedor: escanear el QR de entrega → venta concretada + comisión. */
function parseDeliveryQr(text) {
  const value = String(text || "").trim();
  if (!value.startsWith(QR_PREFIX)) return null;
  const [orderId, code] = value.slice(QR_PREFIX.length).split("|");
  if (!/^[0-9a-f-]{36}$/i.test(orderId || "") || !/^[A-Z0-9]{6}$/i.test(code || "")) return null;
  return { orderId, code: code.toUpperCase() };
}

function openScanSheet(order) {
  const fee = commissionFor(order.total);
  const sheet = openSheet(`
    <div class="eyebrow eyebrow-green">CONFIRMAR ENTREGA · PEDIDO #${escapeHtml(order.code)}</div>
    <h2>Escanea el QR del comprador</h2>
    <p class="dialog-description">Al confirmar declaras que recibiste <strong>${formatPrice(order.total)}</strong> en tu cuenta de Banco Pichincha y entregaste el pedido. Se registrará la venta con una comisión de ${formatPrice(fee)} (${ratePercent()}).</p>
    <div class="scanner-box" id="qr-reader"><span>Activando la cámara…</span></div>
    <form id="manual-code-form" class="manual-code">
      <label>¿Sin cámara? Escribe el código del comprador<input name="code" required minlength="6" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABC234" /></label>
      <button class="button button-dark" type="submit">Confirmar</button>
    </form>`);
  const form = $("#manual-code-form", sheet);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy(form, () => confirmDelivery(order.id, form.elements.code.value));
  });
  startScanner();
}

async function startScanner() {
  const box = $("#qr-reader");
  if (!box) return;
  try {
    await loadScript(SCANNER_SRC);
    if (!els.sheetDialog.open || !box.isConnected) return;
    box.innerHTML = "";
    const scanner = new window.Html5Qrcode("qr-reader");
    state.scanner = scanner;
    let busy = false;
    let lastWarning = 0;
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      async (text) => {
        if (busy) return;
        const parsed = parseDeliveryQr(text);
        if (!parsed) {
          if (Date.now() - lastWarning > 3000) {
            lastWarning = Date.now();
            showToast("Ese no es un QR de entrega de Skill-Link.", true);
          }
          return;
        }
        busy = true;
        if (scanner.isScanning) scanner.pause(true);
        const ok = await confirmDelivery(parsed.orderId, parsed.code);
        if (!ok && state.scanner === scanner) {
          window.setTimeout(() => {
            if (state.scanner === scanner) {
              try { scanner.resume(); } catch (error) { console.warn(error); }
              busy = false;
            }
          }, 1500);
        }
      },
      () => {},
    );
    // Si el diálogo se cerró mientras arrancaba la cámara, se apaga.
    if (state.scanner !== scanner) {
      try { await scanner.stop(); scanner.clear(); } catch (error) { console.warn(error); }
    }
  } catch (error) {
    console.error(error);
    if (box.isConnected) {
      const reason = /permission|notallowed/i.test(String(error?.name || error))
        ? "no diste permiso para usar la cámara"
        : "la cámara no está disponible";
      box.innerHTML = `<span>No se pudo escanear: ${escapeHtml(reason)}. Escribe el código del comprador abajo.</span>`;
    }
  }
}

async function stopScanner() {
  const scanner = state.scanner;
  state.scanner = null;
  if (!scanner) return;
  try {
    if (scanner.isScanning) await scanner.stop();
    scanner.clear();
  } catch (error) {
    console.warn(error);
  }
}

async function confirmDelivery(orderId, code) {
  const { data, error } = await sb.rpc("confirm_delivery", {
    p_order_id: orderId,
    p_code: String(code || "").trim().toUpperCase(),
  });
  if (error) {
    showToast(errorMessage(error), true);
    return false;
  }
  if (!data?.ok) {
    showToast(data?.error || "No se pudo confirmar la entrega.", true);
    return false;
  }
  closeSheet();
  showToast(`¡Venta registrada! Pedido #${data.code} · comisión ${formatPrice(data.commission)} (${ratePercent(data.rate)}).`);
  refreshPanel();
  return true;
}

/* Comprador: reseña. */
function openReviewSheet(order) {
  const stars = [5, 4, 3, 2, 1]
    .map((value) => `<input type="radio" id="star-${value}" name="rating" value="${value}"${value === 5 ? " checked" : ""} /><label for="star-${value}" title="${value} de 5">★</label>`)
    .join("");
  const sheet = openSheet(`
    <div class="eyebrow eyebrow-green">CALIFICA TU COMPRA</div>
    <h2>${escapeHtml(order.product_name)}</h2>
    <p class="dialog-description">Tu reseña ayuda a otras personas de la comunidad a confiar en este emprendimiento.</p>
    <form id="review-form">
      <fieldset class="star-picker"><legend>Tu calificación</legend><div class="stars">${stars}</div></fieldset>
      <label>Comentario (opcional)<textarea name="comment" rows="3" maxlength="300" placeholder="¿Cómo te fue con tu pedido?"></textarea></label>
      <button class="button button-dark dialog-submit" type="submit">Enviar reseña <span>↗</span></button>
    </form>`);
  const form = $("#review-form", sheet);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy(form, async () => {
      const { error } = await sb.rpc("leave_review", {
        p_order_id: order.id,
        p_rating: Number(form.elements.rating.value),
        p_comment: form.elements.comment.value,
      });
      if (error) throw error;
      closeSheet();
      showToast("¡Gracias por tu reseña!");
      refreshPanel();
      loadCatalog();
    });
  });
}

/* Emprendedor: pagar comisiones con el QR de Skill-Link. */
async function openCommissionPaySheet() {
  await loadSettings();
  const amount = panelData.pendingCommissions;
  if (!state.settings.payment_qr_path) {
    throw new Error("Skill-Link aún no configura su QR de cobro. Inténtalo más tarde.");
  }
  const qrUrl = await signedQrUrl(state.settings.payment_qr_path);
  if (!qrUrl) throw new Error("No se pudo cargar el QR de Skill-Link.");
  const holder = state.settings.payment_holder;
  const sheet = openSheet(`
    <div class="eyebrow eyebrow-green">PAGO DE COMISIONES · BANCO PICHINCHA</div>
    <h2>Paga ${formatPrice(amount)} a Skill-Link</h2>
    <p class="dialog-description">Corresponde a tus comisiones por ventas concretadas.${holder ? ` Titular: <strong>${escapeHtml(holder)}</strong>.` : ""}</p>
    <div class="qr-frame"><img src="${escapeHtml(qrUrl)}" alt="QR de cobro de Skill-Link" /></div>
    <ol class="mini-steps">
      <li>Abre tu app de Banco Pichincha (Banca Móvil o DeUna) y elige pagar con QR.</li>
      <li>Escanea el código y paga exactamente <strong>${formatPrice(amount)}</strong>.</li>
      <li>Escribe aquí el número de comprobante.</li>
    </ol>
    <form id="commission-pay-form">
      <label>Número de comprobante<input name="reference" required minlength="3" maxlength="40" autocomplete="off" placeholder="Ej. 123456789" /></label>
      <button class="button button-dark dialog-submit" type="submit">Reportar pago <span>↗</span></button>
      <p class="form-note">Un administrador verificará el comprobante. Mientras tanto, tus comisiones quedan «En revisión».</p>
    </form>`);
  const form = $("#commission-pay-form", sheet);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy(form, async () => {
      const { data, error } = await sb.rpc("report_commission_payment", {
        p_reference: form.elements.reference.value.trim(),
      });
      if (error) throw error;
      closeSheet();
      const reported = Number(data?.amount);
      showToast(reported && toCents(reported) !== toCents(amount)
        ? `Pago reportado por ${formatPrice(reported)} (se incluyeron ventas nuevas). Queda en revisión.`
        : "Pago reportado. Queda en revisión.");
      refreshPanel();
    });
  });
}

/* ---------------------------------------------------------------------
   Acciones del panel
   --------------------------------------------------------------------- */

function getOrder(id) {
  const order = panelData.orders.get(id);
  if (!order) throw new Error("No se encontró el pedido. Actualiza la página.");
  return order;
}

const PANEL_ACTIONS = {
  reload: () => renderPanelTab(),
  "new-listing": () => openPublish(),
  accept: (id) => openAcceptSheet(getOrder(id)),
  pay: (id) => openPaySheet(getOrder(id)),
  "delivery-qr": (id) => openDeliveryQrSheet(getOrder(id)),
  scan: (id) => openScanSheet(getOrder(id)),
  review: (id) => openReviewSheet(getOrder(id)),
  "pay-commissions": () => openCommissionPaySheet(),

  async cancel(id) {
    const order = getOrder(id);
    if (!window.confirm(`¿Cancelar el pedido #${order.code}? No se generará ninguna comisión.`)) return;
    const { error } = await sb.rpc("cancel_order", { p_order_id: id, p_reason: null });
    if (error) throw error;
    showToast("Pedido cancelado.");
    refreshPanel();
  },

  async reject(id) {
    const order = getOrder(id);
    const reason = window.prompt(`¿Por qué rechazas el pedido #${order.code}? (opcional)`, "");
    if (reason === null) return;
    const { error } = await sb.rpc("respond_order", { p_order_id: id, p_accept: false, p_reason: reason });
    if (error) throw error;
    showToast("Pedido rechazado.");
    refreshPanel();
  },

  async "toggle-listing"(id) {
    const product = panelData.products.get(id);
    if (!product) return;
    const { data, error } = await sb.from("products").update({ active: !product.active }).eq("id", id).select();
    if (error) throw error;
    if (!data?.length) throw new Error("No se pudo actualizar la publicación.");
    showToast(product.active ? "Publicación pausada." : "Publicación activa de nuevo.");
    refreshPanel();
    loadCatalog();
  },

  async "delete-listing"(id) {
    const product = panelData.products.get(id);
    if (!product) return;
    if (!window.confirm(`¿Eliminar «${product.name}»? Los pedidos anteriores se conservan en tu historial.`)) return;
    const { data, error } = await sb.from("products").delete().eq("id", id).select();
    if (error) throw error;
    if (!data?.length) throw new Error("No se pudo eliminar la publicación.");
    if (product.image_path) sb.storage.from("product-images").remove([product.image_path]);
    showToast("Publicación eliminada.");
    refreshPanel();
    loadCatalog();
  },

  async "approve-payment"(id) {
    const payment = panelData.payments.get(id);
    if (!payment) return;
    if (!window.confirm(`¿Confirmas que llegaron ${formatPrice(payment.amount)} (comprobante ${payment.reference}) a la cuenta de Skill-Link?`)) return;
    const { error } = await sb.rpc("review_commission_payment", { p_payment_id: id, p_approve: true, p_note: null });
    if (error) throw error;
    showToast("Pago aprobado. Las comisiones quedaron como pagadas.");
    refreshPanel();
  },

  async "reject-payment"(id) {
    const note = window.prompt("Motivo del rechazo (lo verá el emprendedor):", "No encontramos el pago con ese comprobante.");
    if (note === null) return;
    const { error } = await sb.rpc("review_commission_payment", { p_payment_id: id, p_approve: false, p_note: note });
    if (error) throw error;
    showToast("Pago rechazado. Las comisiones volvieron a «Por pagar».");
    refreshPanel();
  },

  async "void-commission"(id) {
    const reason = window.prompt("Motivo de la anulación (por ejemplo, devolución):", "Devolución");
    if (reason === null) return;
    const { error } = await sb.rpc("void_commission", { p_commission_id: id, p_reason: reason });
    if (error) throw error;
    showToast("Comisión anulada.");
    refreshPanel();
  },
};

/* ---------------------------------------------------------------------
   Publicar y pedir
   --------------------------------------------------------------------- */

function openPublish() {
  if (!requireConfigured()) return;
  if (!state.session) {
    openLogin("Ingresa con tu correo PUCE para publicar tu emprendimiento.", openPublish);
    return;
  }
  if (!state.profile?.full_name || !state.profile?.payment_qr_path) {
    showToast("Antes de publicar, completa tu nombre y sube tu QR de cobro de Banco Pichincha.", true);
    location.hash = "#panel/perfil";
    return;
  }
  updatePublishNet();
  els.publishDialog.showModal();
}

async function submitPublish(form) {
  const values = new FormData(form);
  const price = Math.round(Number(values.get("price")) * 100) / 100;
  if (!Number.isFinite(price) || price <= 0) throw new Error("Ingresa un precio mayor que cero.");
  const file = values.get("image");
  let imagePath = null;
  if (file && file.size) {
    const extension = validateImage(file, 3 * 1048576);
    imagePath = `${uid()}/${randomId()}.${extension}`;
    const { error } = await sb.storage.from("product-images").upload(imagePath, file, { contentType: file.type });
    if (error) throw error;
  }
  const { error } = await sb.from("products").insert({
    name: String(values.get("name")).trim(),
    category: String(values.get("category")),
    price,
    description: String(values.get("description")).trim(),
    image_path: imagePath,
    pickup_point: values.get("pickup") === "on",
  });
  if (error) {
    if (imagePath) await sb.storage.from("product-images").remove([imagePath]);
    throw error;
  }
  form.reset();
  els.publishDialog.close();
  showToast("¡Tu publicación ya aparece en el catálogo!");
  await loadCatalog();
  if (!els.panelView.classList.contains("hidden") && state.panelTab === "publicaciones") {
    renderPanelTab();
  } else {
    els.search.value = "";
    selectCategory("Todos");
    location.hash = "#explorar";
  }
}

function updateOrderTotal() {
  const quantity = Math.min(20, Math.max(1, Math.floor(Number($("#order-quantity").value) || 1)));
  const price = Number(state.activeProduct?.price || 0);
  $("#order-total").textContent = formatPrice(Math.round(price * quantity * 100) / 100);
}

function openOrder(productId) {
  if (!requireConfigured()) return;
  const product = state.catalog.find((item) => item.id === productId);
  if (!product) {
    showToast("Este producto ya no está disponible.", true);
    return;
  }
  if (!state.session) {
    openLogin("Ingresa con tu correo PUCE para hacer tu pedido.", () => openOrder(productId));
    return;
  }
  if (product.seller_id === uid()) {
    showToast("Esta es tu propia publicación.");
    return;
  }
  state.activeProduct = product;
  $("#order-form").reset();
  $("#order-product").innerHTML = `<span>${escapeHtml(product.name)} · ${escapeHtml(product.seller_name)}</span><strong>${formatPrice(product.price)}</strong>`;
  $("#order-description").textContent = product.description;
  updateOrderTotal();
  els.orderDialog.showModal();
}

async function submitOrder(form) {
  const product = state.activeProduct;
  if (!product) throw new Error("Este producto ya no está disponible.");
  const values = new FormData(form);
  const { data, error } = await sb.rpc("create_order", {
    p_product_id: product.id,
    p_quantity: Math.floor(Number(values.get("quantity")) || 1),
    p_message: String(values.get("message") || ""),
  });
  if (error) throw error;
  form.reset();
  els.orderDialog.close();
  showToast(`Pedido #${data?.code || ""} enviado. Revisa su estado en «Mis compras».`);
  location.hash = "#panel/compras";
}

/* ---------------------------------------------------------------------
   Eventos
   --------------------------------------------------------------------- */

function bindEvents() {
  // Cerrar cualquier diálogo (también los generados dinámicamente).
  document.addEventListener("click", (event) => {
    const closeButton = event.target.closest("[data-close]");
    if (closeButton) closeButton.closest("dialog")?.close();
  });
  $$("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
  els.sheetDialog.addEventListener("close", stopScanner);

  $("#open-login").addEventListener("click", () => openLogin());
  $("#open-publish").addEventListener("click", openPublish);
  $("#open-publish-bottom").addEventListener("click", openPublish);
  $("#logout-button").addEventListener("click", async () => {
    await sb.auth.signOut();
    showToast("Sesión cerrada.");
  });

  // Inicio de sesión
  $("#login-email-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    withBusy(form, async () => {
      const email = String(new FormData(form).get("email")).trim().toLowerCase();
      if (!PUCE_EMAIL.test(email)) throw new Error("Usa tu correo institucional @puce.edu.ec.");
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, emailRedirectTo: `${location.origin}${location.pathname}` },
      });
      if (error) throw new Error(loginErrorMessage(error));
      state.loginEmail = email;
      $("#login-sent-to").textContent = email;
      showLoginStep("code");
    });
  });
  $("#login-code-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    withBusy(form, async () => {
      const token = String(new FormData(form).get("code")).trim();
      const { error } = await sb.auth.verifyOtp({ email: state.loginEmail, token, type: "email" });
      if (error) {
        throw new Error(/expired|invalid/i.test(error.message)
          ? "El código no es válido o ya expiró. Pide uno nuevo."
          : error.message);
      }
      form.reset();
    });
  });
  $("#login-back").addEventListener("click", () => showLoginStep("email"));

  // Catálogo
  els.search.addEventListener("input", renderProducts);
  els.categories.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-category]");
    if (chip) selectCategory(chip.dataset.category);
  });
  $("#reset-filters").addEventListener("click", () => {
    els.search.value = "";
    selectCategory("Todos");
  });
  els.grid.addEventListener("click", (event) => {
    const favoriteButton = event.target.closest("[data-favorite]");
    if (favoriteButton) {
      toggleFavorite(favoriteButton.dataset.favorite);
      return;
    }
    const orderButton = event.target.closest("[data-order]");
    if (orderButton && !orderButton.disabled) openOrder(orderButton.dataset.order);
  });

  // Calculadora y formularios
  $("#calc-price").addEventListener("input", updateCalculator);
  $("#publish-price").addEventListener("input", updatePublishNet);
  $("#order-quantity").addEventListener("input", updateOrderTotal);
  $("#publish-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.reportValidity()) withBusy(form, () => submitPublish(form));
  });
  $("#order-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.reportValidity()) withBusy(form, () => submitOrder(form));
  });

  // Panel (delegación)
  els.panelContent.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const handler = PANEL_ACTIONS[button.dataset.action];
    if (!handler) return;
    event.preventDefault();
    withBusy(button, () => handler(button.dataset.id, button));
  });
  els.panelContent.addEventListener("submit", (event) => {
    const form = event.target;
    if (form.id === "profile-form") {
      event.preventDefault();
      withBusy(form, () => saveProfile(form));
    } else if (form.id === "admin-settings-form") {
      event.preventDefault();
      withBusy(form, () => saveAdminSettings(form));
    }
  });

  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (!els.homeView.classList.contains("hidden")) els.search.focus();
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === FAVORITES_KEY) renderProducts();
  });
}

async function init() {
  bindEvents();
  updateCalculator();
  updatePublishNet();
  if (!isConfigured) {
    $("#setup-notice").classList.remove("hidden");
    els.count.textContent = "";
    route();
    return;
  }
  loadSettings();
  loadPickupPoints();
  try {
    await initAuth();
  } catch (error) {
    console.error(error);
    showToast(errorMessage(error), true);
  }
  route();
  await loadCatalog();
}

init();
