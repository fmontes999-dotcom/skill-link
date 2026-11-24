"use strict";

/* =====================================================================
   Skill-Link · aplicación web (Supabase + pagos con QR de Banco Pichincha)
   Modelo: comisión del 8% al 10% solo por ventas concretadas.
   ===================================================================== */

const CATEGORY_STYLE = {
  Comida: { emoji: "🥐", tone: "sky" },
  "Arte y regalos": { emoji: "🎨", tone: "indigo" },
  Servicios: { emoji: "✨", tone: "cyan" },
  Bienestar: { emoji: "🌿", tone: "teal" },
};
const DEFAULT_STYLE = { emoji: "✨", tone: "sky" };
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
const THEME_KEY = "skill-link-theme";
const LOGIN_KEY = "skill-link-login-v1";
const OTP_TTL_MS = 15 * 60 * 1000;   // igual que mailer_otp_exp en Supabase (900 s)
const RESEND_WAIT_MS = 60 * 1000;    // Supabase permite un correo por minuto a la misma persona
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTALL_DISMISS_KEY = "skill-link-install-dismissed";
const INSTALL_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;   // el aviso de instalar vuelve a los 14 días
const PANEL_ALIASES = { perfil: "cuenta", publicaciones: "tienda" };
const SELLER_TABS = ["ventas", "tienda", "comisiones"];

const config = window.SKILL_LINK_CONFIG || {};
const isConfigured = Boolean(config.supabaseUrl && config.supabaseAnonKey && window.supabase);

// Correos antiguos con enlace vuelven con #access_token=... (o #error=... si expiró).
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
  store: null,
  settings: { commission_rate: 0.1, min_price: 1, payment_qr_path: null, payment_holder: null },
  catalog: [],
  catalogLoaded: false,
  stores: [],
  storeViewId: null,
  pickupPoints: [],
  category: "Todos",
  activeProduct: null,
  editingProduct: null,
  panelTab: "compras",
  pendingAction: null,   // { type: "order", productId } | { type: "publish" } | { type: "hash", hash }
  login: null,           // { email, sentAt, resent }
  loggingOut: false,
  scanner: null,
};
const panelData = { orders: new Map(), products: new Map(), pendingCommissions: 0, payments: new Map() };
let resolveCatalogReady;
const catalogReady = new Promise((resolve) => { resolveCatalogReady = resolve; });
let pickupReady = Promise.resolve();

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
  storeView: $("#store-view"),
  storeContent: $("#store-content"),
  storeStrip: $("#store-strip"),
  loginDialog: $("#login-dialog"),
  settingsDialog: $("#settings-dialog"),
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

function minPrice() {
  const value = Number(state.settings.min_price);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function minPriceText(value = minPrice()) {
  return `$${Number(value).toFixed(2)}`;
}

function minPriceMessage() {
  return `El precio mínimo de venta en Skill-Link es ${minPriceText()}.`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("es-EC", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

function isSeller() {
  return Boolean(state.profile?.is_seller);
}

function storeInitials(name) {
  const parts = String(name || "SL").trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] || "S"}${parts[1]?.[0] || ""}`.toUpperCase();
}

// Los logos van sobre fondo blanco en ambos temas para que no se pierdan.
function storeLogo(name, path, className = "store-logo") {
  return path
    ? `<span class="${className}"><img src="${escapeHtml(productImageUrl(path))}" alt="" loading="lazy" /></span>`
    : `<span class="${className} store-logo-empty" aria-hidden="true">${escapeHtml(storeInitials(name))}</span>`;
}

// Acepta "@usuario", "usuario" o el enlace completo y devuelve solo el usuario.
function cleanHandle(value) {
  return String(value || "").trim()
    .replace(/^https?:\/\/(www\.|m\.)?(instagram|tiktok|facebook)\.com\//i, "")
    .replace(/^@/, "")
    .replace(/[/?#].*$/, "");
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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  showToast(`Copiado: ${text}`);
}

function copyRow(label, value, copyValue = value, hint = "") {
  return `
    <div class="copy-row">
      <div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</div>
      <button class="button button-outline" type="button" data-copy="${escapeHtml(copyValue)}" aria-label="Copiar ${escapeHtml(label.toLowerCase())}">Copiar</button>
    </div>`;
}

function onPhone() {
  const platform = window.SkillLinkInstall?.platform();
  return platform === "ios" || platform === "android";
}

let toastTimer;
function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("toast-error", isError);
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  const readingTime = Math.max(isError ? 5200 : 3600, message.length * 55);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), readingTime);
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

function isAuthExpired(error) {
  const message = error?.message || String(error || "");
  return error?.status === 401 || error?.code === "PGRST301"
    || /JWT expired|invalid JWT|refresh token|Auth session missing/i.test(message);
}

// Si la sesión caducó a mitad de algo, se pide ingresar otra vez sin cerrar lo que estaba abierto
// (por ejemplo, el formulario del pedido queda detrás y se puede enviar al volver).
async function handleSessionLost() {
  const { data } = await sb.auth.refreshSession().catch(() => ({ data: {} }));
  if (data?.session) {
    showToast("Tu sesión se renovó. Vuelve a intentarlo.");
    return;
  }
  openLogin("Tu sesión se cerró. Ingresa de nuevo para continuar: no perderás lo que estabas haciendo.", {
    type: "hash",
    hash: location.hash,
  });
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
    if (state.session && isAuthExpired(error)) {
      handleSessionLost();
      return undefined;
    }
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
  if (!els.storeView.classList.contains("hidden")) renderStorePage();
}

/* ---------------------------------------------------------------------
   Tema claro / oscuro (se guarda en este dispositivo)
   --------------------------------------------------------------------- */

function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function setTheme(theme, save = true) {
  const value = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = value;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = value === "dark" ? "#163a73" : "#0b2a5b";
  if (save) {
    try {
      localStorage.setItem(THEME_KEY, value);
    } catch {
      // Sin almacenamiento (modo privado estricto): el tema dura hasta cerrar la página.
    }
  }
  $$("[data-theme-switch]").forEach((input) => { input.checked = value === "dark"; });
}

/* ---------------------------------------------------------------------
   Pantalla de carga e instalación como app
   --------------------------------------------------------------------- */

function hideSplash() {
  const splash = $("#splash");
  if (!splash || splash.classList.contains("splash-hide")) return;
  splash.classList.add("splash-hide");
  window.setTimeout(() => splash.remove(), 450);
}

function renderInstallSection() {
  const api = window.SkillLinkInstall;
  const box = $("#install-content");
  if (!api) {
    $("#install-section").classList.add("hidden");
    return;
  }
  if (api.isStandalone()) {
    box.innerHTML = '<p class="install-done">✓ Ya estás usando Skill-Link como app instalada.</p>';
    return;
  }
  box.innerHTML = `${api.canPrompt() ? '<button class="button button-dark install-button" type="button" data-install>Instalar Skill-Link</button>' : ""}${api.guideHtml()}`;
}

function installBannerSnoozed() {
  try {
    return Date.now() - Number(localStorage.getItem(INSTALL_DISMISS_KEY) || 0) < INSTALL_SNOOZE_MS;
  } catch {
    return false;
  }
}

function updateInstallBanner() {
  const api = window.SkillLinkInstall;
  const show = Boolean(api) && !api.isStandalone() && api.platform() !== "desktop" && !installBannerSnoozed();
  $("#install-banner").classList.toggle("hidden", !show);
}

function snoozeInstallBanner() {
  try {
    localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  } catch {
    // Sin almacenamiento: el aviso vuelve a salir la próxima vez.
  }
  $("#install-banner").classList.add("hidden");
}

// Android y computadores: aviso nativo del navegador. iPhone: guía de «Agregar a pantalla de inicio».
async function startInstall() {
  const api = window.SkillLinkInstall;
  if (api?.canPrompt()) {
    const outcome = await api.prompt();
    if (outcome === "accepted") {
      snoozeInstallBanner();
      showToast("¡Listo! Skill-Link se está instalando en tu dispositivo.");
    }
    return;
  }
  renderInstallSection();
  setTheme(currentTheme(), false);
  if (!els.settingsDialog.open) els.settingsDialog.showModal();
  $("#install-section").scrollIntoView({ block: "start" });
}

function themeSwitch() {
  return `
    <label class="switch-row">
      <span><strong>Tema oscuro</strong><small>Más cómodo de noche. Se recuerda en este dispositivo.</small></span>
      <input type="checkbox" role="switch" data-theme-switch${currentTheme() === "dark" ? " checked" : ""} />
    </label>`;
}

/* ---------------------------------------------------------------------
   Configuración, comisión y calculadora
   --------------------------------------------------------------------- */

async function loadSettings() {
  const { data, error } = await sb
    .from("platform_settings")
    .select("commission_rate, payment_qr_path, payment_holder, min_price")
    .maybeSingle();
  if (error) {
    console.error(error);
  } else if (data) {
    state.settings = { ...data, commission_rate: Number(data.commission_rate), min_price: Number(data.min_price) };
  }
  applyRate();
}

async function loadPickupPoints() {
  const { data, error } = await sb.from("pickup_points").select("id, name, schedule").order("id");
  if (error) console.error(error);
  state.pickupPoints = data || [];
}

function applyRate() {
  $$("[data-rate]").forEach((element) => {
    element.textContent = ratePercent();
  });
  $$("[data-min-price]").forEach((element) => {
    element.textContent = minPriceText();
  });
  $("#publish-price").min = minPrice().toFixed(2);
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
  box.classList.remove("net-warning");
  if (!price || price <= 0) {
    box.textContent = `Precio mínimo ${minPriceText()} · comisión del ${ratePercent()} solo cuando vendes.`;
    return;
  }
  if (price < minPrice()) {
    box.classList.add("net-warning");
    box.textContent = minPriceMessage();
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
  resolveCatalogReady();
  renderProducts();
  if (!els.storeView.classList.contains("hidden")) renderStorePage();
}

// Tiendas con modo vendedor activo (la base de datos solo devuelve esas a los visitantes).
async function loadStores() {
  const { data, error } = await sb
    .from("stores")
    .select("seller_id, name, slogan, logo_path")
    .order("updated_at", { ascending: false })
    .limit(60);
  if (error) console.error(error);
  state.stores = (data || []).filter((store) => state.catalog.some((product) => product.seller_id === store.seller_id));
  renderStoreStrip();
}

function renderStoreStrip() {
  const strip = els.storeStrip;
  strip.classList.toggle("hidden", state.stores.length === 0);
  $("#store-strip-list").innerHTML = state.stores.map((store) => `
    <a class="store-chip" href="#tienda/${escapeHtml(store.seller_id)}">
      ${storeLogo(store.name, store.logo_path, "store-logo store-logo-sm")}
      <span><strong>${escapeHtml(store.name)}</strong>${store.slogan ? `<small>${escapeHtml(store.slogan)}</small>` : ""}</span>
    </a>`).join("");
}

function productImageUrl(path) {
  return path ? sb.storage.from("product-images").getPublicUrl(path).data.publicUrl : "";
}

function productCard(product, favorites) {
  const style = CATEGORY_STYLE[product.category] || DEFAULT_STYLE;
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
          <a class="seller-line" href="#tienda/${escapeHtml(product.seller_id)}" title="Ver la tienda de ${escapeHtml(product.seller_name)}"><span class="verified" aria-label="Comunidad PUCE">✦</span><span>${escapeHtml(product.seller_name)}</span></a>
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
  els.count.textContent = `${filtered.length} ${filtered.length === 1 ? "producto" : "productos"}`;
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
   Tienda del emprendedor: su perfil público con todo su catálogo
   --------------------------------------------------------------------- */

function socialLinks(store) {
  return [
    store.instagram ? [`https://www.instagram.com/${store.instagram}`, `Instagram · @${store.instagram}`] : null,
    store.tiktok ? [`https://www.tiktok.com/@${store.tiktok}`, `TikTok · @${store.tiktok}`] : null,
    store.facebook ? [`https://www.facebook.com/${store.facebook}`, `Facebook · ${store.facebook}`] : null,
  ].filter(Boolean);
}

let storePageToken = 0;
async function renderStorePage() {
  const sellerId = state.storeViewId;
  if (!sellerId) return;
  const token = ++storePageToken;
  const content = els.storeContent;
  if (content.dataset.seller !== sellerId) content.innerHTML = '<div class="panel-loading">Cargando tienda…</div>';
  const { data: store, error } = await sb.from("stores").select("*").eq("seller_id", sellerId).maybeSingle();
  await Promise.all([catalogReady, pickupReady]);
  if (token !== storePageToken) return;
  content.dataset.seller = sellerId;
  if (error || !store) {
    if (error) console.error(error);
    content.innerHTML = `
      <a class="back-link" href="#explorar">← Volver al catálogo</a>
      ${emptyPanel("Esta tienda no está disponible", "Puede que el emprendimiento haya pausado sus ventas.", '<a class="button button-dark" href="#explorar">Ver el catálogo</a>')}`;
    return;
  }
  const products = state.catalog.filter((product) => product.seller_id === sellerId);
  const reviews = products.reduce((sum, product) => sum + Number(product.reviews_count || 0), 0);
  const rating = reviews
    ? products.reduce((sum, product) => sum + Number(product.rating || 0) * Number(product.reviews_count || 0), 0) / reviews
    : 0;
  const points = state.pickupPoints.filter((point) => (store.pickup_point_ids || []).includes(point.id));
  const socials = socialLinks(store);
  const info = [
    store.faculty ? ["Carrera o facultad", escapeHtml(store.faculty)] : null,
    store.schedule ? ["Días y horarios", escapeHtml(store.schedule)] : null,
    points.length ? ["Entrega en", points.map((point) => `${escapeHtml(point.name)}<small>${escapeHtml(point.schedule)}</small>`).join("")] : null,
    socials.length ? ["Redes sociales", socials.map(([href, label]) => `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`).join("")] : null,
  ].filter(Boolean);
  const favorites = getFavorites();
  const about = store.description || info.length;
  content.innerHTML = `
    <a class="back-link" href="#explorar">← Volver al catálogo</a>
    <section class="store-hero">
      ${storeLogo(store.name, store.logo_path, "store-logo store-logo-lg")}
      <div class="store-hero-copy">
        <div class="eyebrow eyebrow-green">EMPRENDIMIENTO PUCE</div>
        <h1>${escapeHtml(store.name)}</h1>
        ${store.slogan ? `<p class="store-slogan">${escapeHtml(store.slogan)}</p>` : ""}
        <div class="store-badges">
          <span class="status-chip">${reviews ? `★ ${rating.toFixed(1)} · ${reviews} ${reviews === 1 ? "reseña" : "reseñas"}` : "Nuevo en Skill-Link"}</span>
          <span class="status-chip">${products.length} ${products.length === 1 ? "producto" : "productos"}</span>
        </div>
      </div>
      ${sellerId === uid() ? '<a class="button button-outline" href="#panel/tienda">Editar mi tienda</a>' : ""}
    </section>
    <div class="store-body${about ? "" : " store-body-full"}">
      ${about ? `
        <aside class="store-about">
          ${store.description ? `<h2>Sobre el emprendimiento</h2><p class="store-description">${escapeHtml(store.description)}</p>` : ""}
          ${info.length ? `<dl class="store-info">${info.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`).join("")}</dl>` : ""}
        </aside>` : ""}
      <div class="store-catalog">
        <h2>Catálogo</h2>
        ${products.length
          ? `<div class="product-grid store-grid">${products.map((product) => productCard(product, favorites)).join("")}</div>`
          : '<p class="muted-line">Este emprendimiento todavía no tiene productos disponibles.</p>'}
      </div>
    </div>`;
  document.title = `${store.name} | Skill-Link`;
}

function showStore(sellerId) {
  const changed = state.storeViewId !== sellerId || els.storeView.classList.contains("hidden");
  state.storeViewId = sellerId;
  els.homeView.classList.add("hidden");
  els.panelView.classList.add("hidden");
  els.storeView.classList.remove("hidden");
  if (changed) window.scrollTo(0, 0);
  renderStorePage();
}

/* ---------------------------------------------------------------------
   Sesión: código de 6 dígitos por correo institucional.
   El correo trae solo el código, sin enlace: el filtro de seguridad del correo
   PUCE abría el enlace antes que la persona y eso gastaba el código.
   --------------------------------------------------------------------- */

function loginErrorMessage(error) {
  const message = error?.message || String(error || "");
  const wait = message.match(/after (\d+) seconds?/i);
  if (wait) return `Ya se envió un código a este correo hace menos de un minuto (quizás desde otro dispositivo). Usa ese código o espera ${wait[1]} segundos para pedir otro.`;
  if (/security purposes/i.test(message)) return "Ya se envió un código hace menos de un minuto. Usa ese código o espera un momento para pedir otro.";
  if (/rate limit|too many/i.test(message)) return "Se alcanzó el límite de correos de acceso. Inténtalo en unos minutos.";
  if (/database error saving new user/i.test(message)) return "Solo pueden crear cuenta los correos @puce.edu.ec.";
  if (/error sending|smtp|unexpected_failure/i.test(message)) {
    return "No se pudo enviar el correo con el código: el servicio de correo de Skill-Link está fallando. Avisa a un administrador e inténtalo más tarde.";
  }
  return errorMessage(error);
}

// El código pendiente se guarda en el navegador: si el celular recarga la página mientras
// la persona copia el código en su app de correo, al volver sigue en la pantalla del código.
function savedLogin() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOGIN_KEY) || "null");
    if (saved?.email && Date.now() - Number(saved.sentAt) < OTP_TTL_MS) return saved;
  } catch {
    // Almacenamiento no disponible o dañado.
  }
  clearSavedLogin();
  return null;
}

function saveLogin() {
  try {
    localStorage.setItem(LOGIN_KEY, JSON.stringify({ ...state.login, pending: state.pendingAction }));
  } catch {
    // Sin almacenamiento: el código sirve igual mientras la página no se recargue.
  }
}

function clearSavedLogin() {
  try {
    localStorage.removeItem(LOGIN_KEY);
  } catch {
    // Nada que borrar.
  }
}

function setLoginError(message) {
  const box = $("#login-error");
  box.textContent = message;
  box.classList.toggle("hidden", !message);
}

let resendTimer;
function updateResendButton() {
  const button = $("#login-resend");
  if (!state.login || !els.loginDialog.open) window.clearInterval(resendTimer);
  const wait = state.login ? Math.ceil((state.login.sentAt + RESEND_WAIT_MS - Date.now()) / 1000) : 0;
  button.disabled = wait > 0;
  button.textContent = wait > 0 ? `Reenviar código (${wait} s)` : "Reenviar código";
}

function showCodeStep(notice = "") {
  const login = state.login;
  $("#login-sent-to").textContent = login.email;
  $("#login-status").innerHTML = `${notice ? `<strong>${escapeHtml(notice)}</strong><br />` : ""}`
    + `Enviado a las ${escapeHtml(formatTime(login.sentAt))} · vence a las ${escapeHtml(formatTime(login.sentAt + OTP_TTL_MS))}.`;
  setLoginError("");
  showLoginStep("code");
  const input = $("#login-code");
  input.value = "";
  window.clearInterval(resendTimer);
  resendTimer = window.setInterval(updateResendButton, 1000);
  window.setTimeout(() => {
    updateResendButton();
    input.focus();
  }, 60);
}

async function sendCode(email, isResend = false) {
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  // Si hace menos de un minuto ya se pidió un código (por ejemplo, desde otro dispositivo),
  // ese correo ya llegó: se pasa a la pantalla del código en vez de quedarse con el error.
  const wait = !isResend && error && Number((error.message || "").match(/after (\d+) seconds?/i)?.[1]);
  if (wait) {
    state.login = { email, sentAt: Date.now() - Math.max(0, RESEND_WAIT_MS - wait * 1000) };
    saveLogin();
    showCodeStep("Ya te enviamos un código hace menos de un minuto: búscalo en tu correo y escríbelo aquí.");
    return;
  }
  if (error) throw new Error(loginErrorMessage(error));
  state.login = { email, sentAt: Date.now() };
  saveLogin();
  showCodeStep(isResend ? "Te enviamos un código nuevo. Usa el del correo más reciente: los anteriores ya no sirven." : "");
}

async function resendCode() {
  const button = $("#login-resend");
  if (button.disabled || !state.login) return;
  button.disabled = true;
  try {
    await sendCode(state.login.email, true);
  } catch (error) {
    setLoginError(error.message);
  } finally {
    updateResendButton();
  }
}

async function verifyCode() {
  const login = state.login;
  const input = $("#login-code");
  const token = input.value.replace(/\D/g, "");
  if (!login) {
    showLoginStep("email");
    return;
  }
  const expired = () => Date.now() - login.sentAt > OTP_TTL_MS;
  if (token.length !== 6) {
    setLoginError("Escribe los 6 dígitos del código.");
    return;
  }
  if (expired()) {
    setLoginError("El código venció. Solicita uno nuevo.");
    return;
  }
  setLoginError("");
  const { error } = await sb.auth.verifyOtp({ email: login.email, token, type: "email" });
  if (error) {
    if (expired()) {
      setLoginError("El código venció. Solicita uno nuevo.");
    } else if (error.status === 403 || /expired|invalid/i.test(error.message)) {
      setLoginError("Código incorrecto o ya usado. Cada código sirve una sola vez y solo el último que pediste funciona: si pediste otro desde otro dispositivo, usa ese, o toca «Reenviar código».");
    } else {
      setLoginError(loginErrorMessage(error));
    }
    input.select();
    return;
  }
  // La sesión queda abierta: onAuthStateChange cierra el diálogo y retoma lo pendiente.
  state.login = null;
  clearSavedLogin();
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
    showToast("Ese enlace ya no sirve. Ingresa con el código de 6 dígitos que llega a tu correo.", true);
  }
  const saved = savedLogin();
  if (data.session) {
    clearSavedLogin();
  } else if (saved) {
    state.pendingAction = saved.pending || null;
    state.login = { email: saved.email, sentAt: Number(saved.sentAt) };
    showCodeStep();
    if (!els.loginDialog.open) els.loginDialog.showModal();
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
  } else if (previousUser && !state.loggingOut) {
    // La sesión se cerró sola (caducó): se pide ingresar otra vez y luego se vuelve al mismo lugar.
    const hash = location.hash;
    if (hash.startsWith("#panel")) history.replaceState(null, "", location.pathname);
    openLogin("Tu sesión se cerró. Ingresa de nuevo para continuar donde estabas.", { type: "hash", hash });
  } else if (location.hash.startsWith("#panel")) {
    location.hash = "";
  }
  state.loggingOut = false;
  route();
}

async function setSession(session) {
  state.session = session;
  state.profile = null;
  state.store = null;
  if (session) await loadProfile();
  updateHeader();
  refreshBadge();
}

async function loadProfile() {
  const [profileResult, storeResult] = await Promise.all([
    sb.from("profiles").select("*").eq("id", uid()).maybeSingle(),
    sb.from("stores").select("*").eq("seller_id", uid()).maybeSingle(),
  ]);
  if (profileResult.error) console.error(profileResult.error);
  if (storeResult.error) console.error(storeResult.error);
  state.profile = profileResult.data || null;
  state.store = storeResult.data || null;
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
  $$("[data-seller-tab]").forEach((tab) => tab.classList.toggle("hidden", !isSeller()));
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
  $("#login-reason").textContent = reason || "Te enviaremos un código de 6 dígitos a tu correo. No necesitas contraseña.";
  // Si ya hay un código vigente, se vuelve a esa pantalla en vez de pedir otro.
  if (!state.login || Date.now() - state.login.sentAt > OTP_TTL_MS) {
    const saved = savedLogin();
    state.login = saved ? { email: saved.email, sentAt: Number(saved.sentAt) } : null;
  }
  if (state.login) {
    saveLogin();
    showCodeStep();
  } else {
    showLoginStep("email");
  }
  if (!els.loginDialog.open) els.loginDialog.showModal();
}

function showLoginStep(step) {
  $("#login-email-form").classList.toggle("hidden", step !== "email");
  $("#login-code-form").classList.toggle("hidden", step !== "code");
}

function useOtherEmail() {
  const email = state.login?.email || "";
  state.login = null;
  clearSavedLogin();
  window.clearInterval(resendTimer);
  showLoginStep("email");
  const input = $("#login-email-form").elements.email;
  input.value = email;
  input.focus();
}

async function runPendingAction(action) {
  if (action?.type === "order" && action.productId) {
    await catalogReady;
    openOrder(action.productId);
    return true;
  }
  if (action?.type === "publish") {
    openProductDialog();
    return true;
  }
  if (action?.type === "hash" && typeof action.hash === "string") {
    if (location.hash !== action.hash) location.hash = action.hash;
    return true;
  }
  return false;
}

async function onSignedIn() {
  if (els.loginDialog.open) els.loginDialog.close();
  state.login = null;
  clearSavedLogin();
  const pending = state.pendingAction;
  state.pendingAction = null;
  if (pending && await runPendingAction(pending)) return;
  if (!state.profile?.full_name) {
    showToast("¡Bienvenido! Escribe tu nombre para empezar.");
    location.hash = "#panel/cuenta";
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
  tienda: renderMyStore,
  comisiones: renderCommissions,
  cuenta: renderAccount,
  admin: renderAdmin,
};
const DEFAULT_TITLE = document.title;

function route() {
  const hash = location.hash;
  if (hash.startsWith("#tienda/")) {
    const sellerId = decodeURIComponent(hash.slice("#tienda/".length));
    if (isConfigured && UUID_RE.test(sellerId)) {
      showStore(sellerId);
      return;
    }
  }
  document.title = DEFAULT_TITLE;
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
      openLogin("Ingresa con tu correo PUCE para ver tu panel.", { type: "hash", hash: target });
      return;
    }
    const requested = hash.split("/")[1] || state.panelTab;
    const tab = PANEL_ALIASES[requested] || requested;
    showPanel(PANEL_TABS[tab] ? tab : "compras");
    return;
  }
  showHome();
}

function showHome() {
  const wasHidden = els.homeView.classList.contains("hidden");
  els.homeView.classList.remove("hidden");
  els.panelView.classList.add("hidden");
  els.storeView.classList.add("hidden");
  if (!wasHidden) return;
  const id = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : "";
  const target = id && /^[\w-]+$/.test(id) ? document.getElementById(id) : null;
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
}

function showPanel(tab) {
  if (tab === "admin" && state.profile?.role !== "admin") tab = "compras";
  if (SELLER_TABS.includes(tab) && !isSeller()) tab = "cuenta";
  const changed = state.panelTab !== tab || els.panelView.classList.contains("hidden");
  state.panelTab = tab;
  els.homeView.classList.add("hidden");
  els.storeView.classList.add("hidden");
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
  if (!isBuyer && commission) {
    details.push([`Comisión (${ratePercent(commission.rate)})`, formatPrice(commission.amount)]);
  } else if (!isBuyer && ["pendiente", "aceptado"].includes(order.status)) {
    // Antes de entregar, el emprendedor ve cuánto se le cobrará y cuánto le queda.
    const fee = commissionFor(order.total);
    details.push([`Comisión al entregar (${ratePercent()})`, formatPrice(fee)]);
    details.push(["Te queda", formatPrice(order.total - fee)]);
  }

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
        : `Aún no se reporta el pago. Si te paga en el Punto Link, muéstrale tu QR de cobro. Verifica en tu app de Banco Pichincha que recibiste ${formatPrice(order.total)} antes de entregar.`;
      noteTone = paid ? "ok" : "attention";
      actions.push(`<button class="button button-dark" type="button" data-action="scan" data-id="${id}">Escanear QR de entrega</button>`);
      if (!paid) actions.push(`<button class="button button-outline" type="button" data-action="show-my-qr" data-id="${id}">Mostrar mi QR de cobro</button>`);
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
    : '<p class="order-note note-attention">Aún no subiste tu QR de cobro de Banco Pichincha. <a href="#panel/tienda">Súbelo en Mi tienda</a> para que te puedan pagar.</p>';
  const head = sectionHead("Mis ventas", "Al entregar, escanea el QR del comprador: así la venta queda registrada.");
  if (!data.length) {
    return head + warning + emptyPanel("Todavía no tienes pedidos", "Cuando alguien pida uno de tus productos, aparecerá aquí.", '<a class="button button-dark" href="#panel/tienda">Ir a mi tienda</a>');
  }
  return head + stats + warning + groupOrders(data, "seller");
}

/* ---------------------------------------------------------------------
   Panel · mi tienda (perfil del emprendimiento + catálogo)
   --------------------------------------------------------------------- */

function listingRow(product) {
  const style = CATEGORY_STYLE[product.category] || DEFAULT_STYLE;
  const id = escapeHtml(product.id);
  const belowMin = Number(product.price) < minPrice();
  const thumb = product.image_path
    ? `<img src="${escapeHtml(productImageUrl(product.image_path))}" alt="" loading="lazy" />`
    : `<span aria-hidden="true">${style.emoji}</span>`;
  return `
    <article class="listing-row">
      <div class="listing-thumb tone-${style.tone}">${thumb}</div>
      <div class="listing-info">
        <h3>${escapeHtml(product.name)}</h3>
        <p>${escapeHtml(product.category)} · ${formatPrice(product.price)} · recibes ${formatPrice(product.price - commissionFor(product.price))}</p>
        ${belowMin ? `<small class="listing-warning">Pausado: el precio es menor al mínimo de ${minPriceText()}. Edítalo para volver a mostrarlo.</small>` : ""}
      </div>
      <span class="status-chip ${product.active ? "status-completado" : "status-cancelado"}">${product.active ? "Activo" : "Pausado"}</span>
      <div class="listing-actions">
        <button class="button button-outline" type="button" data-action="edit-listing" data-id="${id}">Editar</button>
        <button class="button button-outline" type="button" data-action="toggle-listing" data-id="${id}">${product.active ? "Pausar" : "Activar"}</button>
        <button class="button button-ghost" type="button" data-action="delete-listing" data-id="${id}">Eliminar</button>
      </div>
    </article>`;
}

async function renderMyStore() {
  await loadProfile();
  updateHeader();
  const profile = state.profile;
  const store = state.store;
  const { data, error } = await sb
    .from("products")
    .select("*")
    .eq("seller_id", uid())
    .order("created_at", { ascending: false });
  if (error) throw error;
  panelData.products.clear();
  data.forEach((product) => panelData.products.set(product.id, product));
  const qrUrl = await signedQrUrl(profile?.payment_qr_path);
  const selected = store?.pickup_point_ids || [];
  const points = state.pickupPoints.map((point) => `
    <label class="checkbox-label"><input type="checkbox" name="points" value="${escapeHtml(point.id)}"${selected.includes(point.id) ? " checked" : ""} /> ${escapeHtml(point.name)} <small>${escapeHtml(point.schedule)}</small></label>`).join("");
  const field = (name) => escapeHtml(store?.[name] || "");
  const ready = Boolean(store && profile?.payment_qr_path && profile?.full_name);

  const head = sectionHead(
    "Mi tienda",
    "Tu perfil de emprendimiento y tu catálogo en un solo lugar. Lo completas una vez y luego solo agregas o editas productos.",
    store ? `<a class="button button-outline" href="#tienda/${escapeHtml(uid())}">Ver mi tienda ↗</a>` : "",
  );
  const intro = store
    ? ""
    : '<p class="order-note note-attention">Completa el perfil de tu emprendimiento y sube tu QR de cobro para empezar a vender.</p>';

  const form = `
    <form class="panel-form" id="store-form">
      <div class="panel-form-grid">
        <div class="panel-card">
          <h3>Perfil del emprendimiento</h3>
          <div class="logo-field">
            ${storeLogo(store?.name || profile?.full_name, store?.logo_path, "store-logo store-logo-md")}
            <label>${store?.logo_path ? "Cambiar logo" : "Logo"} (PNG con fondo transparente si puedes · máx. 2 MB)<input name="logo" type="file" accept="image/jpeg,image/png,image/webp" /></label>
          </div>
          <label>Nombre del emprendimiento<input name="name" required minlength="2" maxlength="60" value="${field("name")}" placeholder="Ej. Ruby Craft" /></label>
          <label>Eslogan (opcional)<input name="slogan" maxlength="90" value="${field("slogan")}" placeholder="Una frase corta que resuma tu emprendimiento" /></label>
          <label>Descripción<textarea name="description" rows="4" maxlength="600" placeholder="Quién eres y qué ofreces">${field("description")}</textarea></label>
        </div>
        <div class="panel-card">
          <h3>Información adicional</h3>
          <label>Carrera o facultad (opcional: solo si quieres mostrarla)<input name="faculty" maxlength="80" value="${field("faculty")}" placeholder="Ej. Administración de Empresas" /></label>
          <label>Días y horarios disponibles<input name="schedule" maxlength="120" value="${field("schedule")}" placeholder="Ej. Lunes a jueves, de 10:00 a 14:00" /></label>
          <fieldset class="point-picker"><legend>Puntos Link donde entregas</legend>${points || '<p class="help-text">Todavía no hay Puntos Link configurados.</p>'}</fieldset>
          <label>Instagram (opcional)<input name="instagram" maxlength="80" value="${field("instagram")}" placeholder="@tuemprendimiento" autocapitalize="off" spellcheck="false" /></label>
          <label>TikTok (opcional)<input name="tiktok" maxlength="80" value="${field("tiktok")}" placeholder="@tuemprendimiento" autocapitalize="off" spellcheck="false" /></label>
          <label>Facebook (opcional)<input name="facebook" maxlength="120" value="${field("facebook")}" placeholder="Nombre de usuario de tu página" autocapitalize="off" spellcheck="false" /></label>
        </div>
        <div class="panel-card panel-card-wide">
          <h3>QR de cobro · Banco Pichincha</h3>
          <p class="help-text">Lo necesitas para vender. Los compradores lo escanean desde su app para pagarte directamente. Solo lo ve quien tiene un pedido aceptado contigo.</p>
          <div class="qr-row">
            <div class="qr-preview">${qrUrl ? `<img src="${escapeHtml(qrUrl)}" alt="Tu QR de cobro" />` : "<span>Sin QR todavía</span>"}</div>
            <div class="qr-fields">
              <label>${profile?.payment_qr_path ? "Reemplazar imagen del QR" : "Imagen de tu QR (PNG, JPG o WebP · máx. 2 MB)"}<input name="qr" type="file" accept="image/jpeg,image/png,image/webp" /></label>
              <label>Titular de la cuenta<input name="holder" maxlength="60" value="${escapeHtml(profile?.payment_holder || "")}" placeholder="Nombre que aparece al pagar" /></label>
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
        </div>
      </div>
      <button class="button button-dark" type="submit">${store ? "Guardar cambios de la tienda" : "Crear mi tienda"} <span>↗</span></button>
    </form>`;

  const catalogHead = `
    <div class="panel-section-head catalog-head">
      <div>
        <h2>Catálogo de productos · ${data.length}</h2>
        <p>Cada producto tiene su propio precio (mínimo ${minPriceText()}). Para cambiar un precio, edita el producto: no hace falta publicarlo de nuevo.</p>
      </div>
      <button class="button button-dark" type="button" data-action="new-listing"${ready ? "" : " disabled"}>＋ Agregar producto</button>
    </div>`;
  const warning = ready
    ? ""
    : '<p class="order-note note-attention">Guarda tu tienda y tu QR de cobro para poder agregar productos.</p>';
  const list = data.length
    ? `<div class="listing-list">${data.map(listingRow).join("")}</div>`
    : emptyPanel("Tu catálogo está vacío", "Agrega tus productos o servicios, cada uno con su foto, su descripción y su precio.");
  return head + intro + form + catalogHead + warning + list;
}

async function saveStore(form) {
  const values = new FormData(form);
  const text = (name, max) => String(values.get(name) || "").trim().replace(/\s+/g, " ").slice(0, max);
  const name = text("name", 60);
  if (name.length < 2) throw new Error("Escribe el nombre de tu emprendimiento.");
  const handles = {};
  for (const [key, pattern, label] of [
    ["instagram", /^[A-Za-z0-9._]{1,30}$/, "Instagram"],
    ["tiktok", /^[A-Za-z0-9._]{1,30}$/, "TikTok"],
    ["facebook", /^[A-Za-z0-9.-]{1,80}$/, "Facebook"],
  ]) {
    const value = cleanHandle(values.get(key));
    if (value && !pattern.test(value)) throw new Error(`El usuario de ${label} no es válido. Escribe solo el nombre de usuario.`);
    handles[key] = value || null;
  }
  const description = String(values.get("description") || "").trim().slice(0, 600);
  const storeUpdate = {
    name,
    slogan: text("slogan", 90) || null,
    description: description || null,
    faculty: text("faculty", 80) || null,
    schedule: text("schedule", 120) || null,
    pickup_point_ids: values.getAll("points").map(Number).filter(Number.isInteger),
    ...handles,
  };
  const profileUpdate = { payment_holder: text("holder", 60) || null };
  const uploads = [];   // archivos subidos que se borran si algo falla
  const upload = async (bucket, file, prefix, maxBytes) => {
    const extension = validateImage(file, maxBytes);
    const path = `${uid()}/${prefix}-${Date.now()}.${extension}`;
    const { error } = await sb.storage.from(bucket).upload(path, file, { contentType: file.type });
    if (error) throw error;
    uploads.push({ bucket, path });
    return path;
  };
  const oldLogo = state.store?.logo_path;
  const oldQr = state.profile?.payment_qr_path;
  try {
    const logo = values.get("logo");
    if (logo && logo.size) storeUpdate.logo_path = await upload("product-images", logo, "logo", 2 * 1048576);
    const qr = values.get("qr");
    if (qr && qr.size) profileUpdate.payment_qr_path = await upload("payment-qr", qr, "qr", 2 * 1048576);

    const { data: store, error: storeError } = state.store
      ? await sb.from("stores").update(storeUpdate).eq("seller_id", uid()).select().maybeSingle()
      : await sb.from("stores").insert(storeUpdate).select().maybeSingle();
    if (storeError || !store) throw storeError || new Error("No se pudo guardar tu tienda.");
    state.store = store;
    if (storeUpdate.logo_path) uploads.splice(uploads.findIndex((item) => item.path === storeUpdate.logo_path), 1);

    const { data: profile, error: profileError } = await sb.from("profiles").update(profileUpdate).eq("id", uid()).select().maybeSingle();
    if (profileError || !profile) throw profileError || new Error("No se pudo guardar tu QR de cobro.");
    state.profile = profile;
    uploads.length = 0;
  } catch (error) {
    if (uploads.length) await Promise.all(uploads.map(({ bucket, path }) => sb.storage.from(bucket).remove([path])));
    throw error;
  }
  if (storeUpdate.logo_path && oldLogo && oldLogo !== storeUpdate.logo_path) sb.storage.from("product-images").remove([oldLogo]);
  if (profileUpdate.payment_qr_path && oldQr && oldQr !== profileUpdate.payment_qr_path) sb.storage.from("payment-qr").remove([oldQr]);
  showToast(state.profile.payment_qr_path ? "Tienda guardada. ¡Ya puedes agregar productos!" : "Tienda guardada. Sube tu QR de cobro para poder vender.");
  renderPanelTab();
  await loadCatalog();
  loadStores();
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

/* ---------------------------------------------------------------------
   Panel · cuenta (datos, modo vendedor y configuración)
   --------------------------------------------------------------------- */

async function renderAccount() {
  await loadProfile();
  updateHeader();
  const profile = state.profile;
  if (!profile) {
    return emptyPanel("No encontramos tu perfil", "Cierra sesión y vuelve a ingresar. Si el problema sigue, contacta a soporte.");
  }
  const seller = isSeller();
  const sellerText = seller
    ? "Tu tienda está activa y tus productos aparecen en el catálogo."
    : `Actívalo para crear tu tienda y publicar tus productos. Publicar es gratis: solo pagas una comisión del ${ratePercent()} cuando vendes.`;
  const sellerLinks = seller
    ? `<p class="account-links"><a class="text-button" href="#panel/tienda">Ir a mi tienda</a>${state.store ? ` · <a class="text-button" href="#tienda/${escapeHtml(uid())}">Verla como comprador</a>` : ""}</p>`
    : "";
  return sectionHead("Cuenta", "Tus datos, la opción para vender y la configuración de la aplicación.") + `
    <div class="panel-form-grid">
      <form class="panel-card" id="account-form">
        <h3>Tus datos</h3>
        <label>Nombre completo<input name="full_name" required minlength="3" maxlength="60" value="${escapeHtml(profile.full_name)}" placeholder="Ej. Camila Ajila" autocomplete="name" /></label>
        <label>Correo institucional<input value="${escapeHtml(profile.email)}" disabled /></label>
        <label>WhatsApp (opcional)<input name="phone" maxlength="16" pattern="[0-9+ ]{7,16}" value="${escapeHtml(profile.phone || "")}" placeholder="0991234567" inputmode="tel" autocomplete="tel" /></label>
        <p class="help-text">Tu nombre, correo y WhatsApp solo los ven las personas con las que tienes un pedido.</p>
        <button class="button button-dark" type="submit">Guardar datos</button>
      </form>
      <div class="panel-stack">
        <div class="panel-card">
          <h3>Vender en Skill-Link</h3>
          <label class="switch-row">
            <span><strong>Quiero vender</strong><small>${escapeHtml(sellerText)}</small></span>
            <input type="checkbox" role="switch" id="seller-switch"${seller ? " checked" : ""} />
          </label>
          ${sellerLinks}
        </div>
        <div class="panel-card">
          <h3>Configuración</h3>
          ${themeSwitch()}
        </div>
      </div>
    </div>`;
}

async function saveAccount(form) {
  const values = new FormData(form);
  const fullName = String(values.get("full_name") || "").trim().replace(/\s+/g, " ");
  const phone = String(values.get("phone") || "").trim();
  if (fullName.length < 3) throw new Error("Escribe tu nombre completo.");
  if (phone && !/^[0-9+ ]{7,16}$/.test(phone)) throw new Error("El número de WhatsApp no es válido.");
  const { data, error } = await sb
    .from("profiles")
    .update({ full_name: fullName, phone: phone || null })
    .eq("id", uid())
    .select()
    .maybeSingle();
  if (error || !data) throw error || new Error("No se pudieron guardar tus datos.");
  state.profile = data;
  updateHeader();
  $("#panel-greeting").textContent = `Hola, ${fullName.split(" ")[0]}`;
  showToast("Datos guardados.");
}

async function setSellerFlag(value) {
  const { data, error } = await sb.from("profiles").update({ is_seller: value }).eq("id", uid()).select().maybeSingle();
  if (error || !data) throw error || new Error("No se pudo cambiar el modo vendedor.");
  state.profile = data;
  updateHeader();
}

// «Quiero vender»: todos entran como compradores y activan la venta desde aquí.
async function toggleSeller(input) {
  const wantsToSell = input.checked;
  input.disabled = true;
  try {
    if (wantsToSell) {
      if (!state.profile?.full_name) throw new Error("Primero escribe y guarda tu nombre completo.");
      await setSellerFlag(true);
      showToast("Modo vendedor activado. Completa el perfil de tu emprendimiento.");
      location.hash = "#panel/tienda";
    } else {
      const [ordersResult, commissionsResult] = await Promise.all([
        sb.from("orders").select("id", { count: "exact", head: true }).eq("seller_id", uid()).in("status", ["pendiente", "aceptado"]),
        sb.from("commissions").select("id", { count: "exact", head: true }).eq("seller_id", uid()).in("status", ["pendiente", "en_revision"]),
      ]);
      if (ordersResult.error || commissionsResult.error) throw ordersResult.error || commissionsResult.error;
      if (ordersResult.count) throw new Error("Tienes pedidos en curso. Entrégalos o cancélalos antes de dejar de vender.");
      if (commissionsResult.count) throw new Error("Tienes comisiones por pagar o en revisión. Págalas antes de dejar de vender.");
      if (!window.confirm("Tu tienda y tus productos dejarán de verse en el catálogo. Puedes volver a activarla cuando quieras. ¿Dejar de vender?")) {
        input.checked = true;
        return;
      }
      await setSellerFlag(false);
      showToast("Modo vendedor desactivado. Tu tienda ya no aparece en el catálogo.");
      renderPanelTab();
    }
    await loadCatalog();
    loadStores();
  } catch (error) {
    console.error(error);
    input.checked = !wantsToSell;
    showToast(errorMessage(error), true);
  } finally {
    input.disabled = false;
  }
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
          <label>Precio mínimo de venta (USD)<input name="min_price" type="number" min="0.01" max="1000" step="0.01" required inputmode="decimal" value="${escapeHtml(Number(settings.min_price || 1).toFixed(2))}" /></label>
          <p class="help-text">Ningún producto puede publicarse por menos. Si lo subes, los productos más baratos quedan pausados hasta que su dueño corrija el precio.</p>
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
  const newMin = Math.round(Number(values.get("min_price")) * 100) / 100;
  if (!Number.isFinite(newMin) || newMin < 0.01 || newMin > 1000) throw new Error("El precio mínimo debe estar entre $0.01 y $1000.");
  const minRaised = newMin > minPrice();
  const update = {
    commission_rate: rate,
    min_price: newMin,
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
  showToast(minRaised
    ? `Configuración guardada. Los productos de menos de ${minPriceText()} quedaron pausados hasta que se corrijan.`
    : "Configuración guardada.");
  renderPanelTab();
  if (minRaised) loadCatalog().then(loadStores);
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
    colorDark: "#0b2a5b",
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

function paymentReference(order) {
  return `SKL-${order.code}`;
}

/* Emprendedor: mostrar su QR de cobro en su celular para que el comprador lo escanee con el suyo. */
async function openMyQrSheet(order) {
  const url = await signedQrUrl(state.profile?.payment_qr_path);
  if (!url) throw new Error("Aún no subiste tu QR de cobro. Súbelo en Mi tienda.");
  openSheet(`
    <div class="eyebrow eyebrow-green">TU QR DE COBRO · PEDIDO #${escapeHtml(order.code)}</div>
    <h2>Cobra ${formatPrice(order.total)}</h2>
    <p class="dialog-description">Muéstralo al comprador para que lo escanee desde su celular con la app de Banco Pichincha o DeUna. Referencia: <strong>${escapeHtml(paymentReference(order))}</strong>.</p>
    <div class="qr-frame qr-frame-large"><img src="${escapeHtml(url)}" alt="Tu QR de cobro de Banco Pichincha" /></div>
    <p class="commission-note">El comprador te paga el total. Al confirmar la entrega se registra tu comisión de ${formatPrice(commissionFor(order.total))} (${ratePercent()}), que pagas después a Skill-Link desde <strong>Comisiones</strong>. Te quedan ${formatPrice(order.total - commissionFor(order.total))}.</p>
    <p class="form-note">Revisa en tu app del banco que llegó el pago antes de entregar. Después escanea el <strong>QR de entrega</strong> del comprador para registrar la venta.</p>`);
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
  const reference = paymentReference(order);
  const qrBlock = `
    <div class="qr-frame"><img src="${escapeHtml(viewUrl)}" alt="QR de cobro de Banco Pichincha de ${escapeHtml(holder)}" /></div>
    ${downloadUrl ? `<a class="text-button qr-download" href="${escapeHtml(downloadUrl)}">Descargar la imagen del QR</a>` : ""}`;
  // Desde el mismo celular no se puede escanear la propia pantalla: en el teléfono se ofrece
  // pagar en el Punto Link con el QR que muestra el emprendedor en SU celular.
  const howToPay = onPhone()
    ? `
      <div class="pay-option pay-option-main">
        <strong>¿Pagas desde este mismo celular?</strong>
        <p>Tu app del banco no puede escanear tu propia pantalla. En el Punto Link, ${escapeHtml(holder)} te muestra su QR de cobro en su celular y tú lo escaneas con la app de Banco Pichincha o DeUna.</p>
      </div>
      <details class="pay-option">
        <summary>Pagar ahora desde otro dispositivo (ver el QR)</summary>
        ${qrBlock}
        <p class="form-note">Ábrelo en un computador o tablet y escanéalo con tu celular.</p>
      </details>`
    : qrBlock;
  const sheet = openSheet(`
    <div class="eyebrow eyebrow-green">PAGO DIRECTO AL EMPRENDEDOR · BANCO PICHINCHA</div>
    <h2>Paga ${formatPrice(order.total)}</h2>
    <p class="dialog-description">Pedido #${escapeHtml(order.code)} · ${escapeHtml(order.product_name)}. Pagas el precio publicado, sin recargos, directo a la cuenta de <strong>${escapeHtml(holder)}</strong>.</p>
    <p class="commission-note"><strong>¿Y la comisión de Skill-Link?</strong> La paga el emprendedor, no tú. Cuando se confirma la entrega, se le registra el ${ratePercent()} de la venta (${formatPrice(commissionFor(order.total))}) y él lo paga después a Skill-Link desde su panel.</p>
    <div class="copy-list">
      ${copyRow("Monto exacto", formatPrice(order.total), Number(order.total).toFixed(2))}
      ${copyRow("Referencia del pago", reference, reference, "Escríbela en la descripción del pago.")}
    </div>
    ${howToPay}
    <ol class="mini-steps">
      <li>En la app de Banco Pichincha (Banca Móvil o DeUna), elige pagar con QR y escanea el código.</li>
      <li>Verifica que el titular sea <strong>${escapeHtml(holder)}</strong> y paga exactamente <strong>${formatPrice(order.total)}</strong>.</li>
      <li>Escribe aquí el número de comprobante.</li>
    </ol>
    <form id="pay-form">
      <label>Número de comprobante<input name="reference" required minlength="3" maxlength="40" value="${escapeHtml(order.payment_reference || "")}" placeholder="Ej. 123456789" autocomplete="off" /></label>
      <button class="button button-dark dialog-submit" type="submit">${order.payment_reference ? "Actualizar comprobante" : "Ya pagué"} <span>↗</span></button>
      <p class="form-note">Este QR es solo para pagar. El <strong>QR de entrega</strong> es otro: lo muestras cuando recibes tu pedido.</p>
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
    <p class="dialog-description">Enséñalo solo cuando tengas el pedido en tus manos. <strong>No es para pagar:</strong> el emprendedor lo escanea desde su celular para confirmar que recibió tu pago y que te entregó el pedido.</p>
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
    <h2>Escanea el QR de entrega del comprador</h2>
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
  "new-listing": () => openProductDialog(),
  "edit-listing": (id) => {
    const product = panelData.products.get(id);
    if (!product) throw new Error("No se encontró el producto. Actualiza la página.");
    openProductDialog(product);
  },
  accept: (id) => openAcceptSheet(getOrder(id)),
  pay: (id) => openPaySheet(getOrder(id)),
  "delivery-qr": (id) => openDeliveryQrSheet(getOrder(id)),
  "show-my-qr": (id) => openMyQrSheet(getOrder(id)),
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
    if (!product.active && Number(product.price) < minPrice()) {
      throw new Error(`${minPriceMessage()} Edita el precio para volver a mostrarlo.`);
    }
    const { data, error } = await sb.from("products").update({ active: !product.active }).eq("id", id).select();
    if (error) throw error;
    if (!data?.length) throw new Error("No se pudo actualizar el producto.");
    showToast(product.active ? "Producto pausado: ya no aparece en el catálogo." : "Producto activo de nuevo.");
    refreshPanel();
    loadCatalog();
  },

  async "delete-listing"(id) {
    const product = panelData.products.get(id);
    if (!product) return;
    if (!window.confirm(`¿Eliminar «${product.name}»? Los pedidos anteriores se conservan en tu historial.`)) return;
    const { data, error } = await sb.from("products").delete().eq("id", id).select();
    if (error) throw error;
    if (!data?.length) throw new Error("No se pudo eliminar el producto.");
    if (product.image_path) sb.storage.from("product-images").remove([product.image_path]);
    showToast("Producto eliminado.");
    refreshPanel();
    loadCatalog().then(loadStores);
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
   Productos (agregar / editar) y pedidos
   --------------------------------------------------------------------- */

// Revisa que la persona pueda vender y la lleva al paso que le falta.
function canAddProducts() {
  if (!requireConfigured()) return false;
  if (!state.session) {
    openLogin("Ingresa con tu correo PUCE para vender en Skill-Link.", { type: "publish" });
    return false;
  }
  if (!isSeller()) {
    showToast("Para vender, activa «Quiero vender» en tu cuenta.");
    location.hash = "#panel/cuenta";
    return false;
  }
  if (!state.store || !state.profile?.full_name || !state.profile?.payment_qr_path) {
    showToast("Antes de agregar productos, guarda el perfil de tu tienda y tu QR de cobro.", true);
    location.hash = "#panel/tienda";
    return false;
  }
  return true;
}

function openProductDialog(product = null) {
  if (!canAddProducts()) return;
  const form = $("#publish-form");
  form.reset();
  state.editingProduct = product;
  $("#publish-title").textContent = product ? "Editar producto" : "Agregar producto";
  $("#publish-submit").innerHTML = product ? "Guardar cambios <span>↗</span>" : "Agregar a mi catálogo <span>↗</span>";
  if (product) {
    form.elements.name.value = product.name;
    form.elements.category.value = product.category;
    form.elements.price.value = Number(product.price).toFixed(2);
    form.elements.description.value = product.description;
    form.elements.pickup.checked = Boolean(product.pickup_point);
  }
  form.elements.active.checked = product ? Boolean(product.active) : true;
  $("#publish-image-text").textContent = product?.image_path
    ? "Cambiar foto (opcional · JPG, PNG o WebP, máx. 3 MB)"
    : "Foto (opcional · JPG, PNG o WebP, máx. 3 MB)";
  const current = $("#publish-current-image");
  current.innerHTML = product?.image_path ? `<img src="${escapeHtml(productImageUrl(product.image_path))}" alt="Foto actual del producto" />` : "";
  current.classList.toggle("hidden", !product?.image_path);
  applyRate();
  els.publishDialog.showModal();
}

async function submitProduct(form) {
  const values = new FormData(form);
  const product = state.editingProduct;
  const price = Math.round(Number(values.get("price")) * 100) / 100;
  if (!Number.isFinite(price) || price <= 0) throw new Error("Ingresa un precio válido.");
  if (price < minPrice()) throw new Error(minPriceMessage());
  const row = {
    name: String(values.get("name")).trim(),
    category: String(values.get("category")),
    price,
    description: String(values.get("description")).trim(),
    pickup_point: values.get("pickup") === "on",
    active: values.get("active") === "on",
  };
  const file = values.get("image");
  let imagePath = null;
  if (file && file.size) {
    const extension = validateImage(file, 3 * 1048576);
    imagePath = `${uid()}/${randomId()}.${extension}`;
    const { error } = await sb.storage.from("product-images").upload(imagePath, file, { contentType: file.type });
    if (error) throw error;
    row.image_path = imagePath;
  }
  const { data, error } = product
    ? await sb.from("products").update(row).eq("id", product.id).select()
    : await sb.from("products").insert(row).select();
  if (error || !data?.length) {
    if (imagePath) await sb.storage.from("product-images").remove([imagePath]);
    throw error || new Error("No se pudo guardar el producto.");
  }
  if (product && imagePath && product.image_path) sb.storage.from("product-images").remove([product.image_path]);
  form.reset();
  state.editingProduct = null;
  els.publishDialog.close();
  showToast(product
    ? "Producto actualizado."
    : row.active ? "¡Listo! Tu producto ya aparece en tu tienda y en el catálogo." : "Producto guardado como pausado.");
  await loadCatalog();
  loadStores();
  if (!els.panelView.classList.contains("hidden") && state.panelTab === "tienda") renderPanelTab();
  else if (!product) location.hash = "#panel/tienda";
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
    openLogin("Ingresa con tu correo PUCE para hacer tu pedido.", { type: "order", productId });
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
    const copyButton = event.target.closest("[data-copy]");
    if (copyButton) copyText(copyButton.dataset.copy);
    if (event.target.closest("[data-install]")) startInstall();
  });

  // Instalación como app
  $("#install-banner-button").addEventListener("click", startInstall);
  $("#install-banner-close").addEventListener("click", snoozeInstallBanner);
  window.SkillLinkInstall?.onChange(() => {
    renderInstallSection();
    updateInstallBanner();
  });
  $$("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
  els.sheetDialog.addEventListener("close", stopScanner);
  els.loginDialog.addEventListener("close", () => window.clearInterval(resendTimer));

  $("#open-login").addEventListener("click", () => openLogin());
  $("#open-publish").addEventListener("click", () => openProductDialog());
  $("#open-publish-bottom").addEventListener("click", () => openProductDialog());
  $("#logout-button").addEventListener("click", async () => {
    state.loggingOut = true;
    await sb.auth.signOut();
    showToast("Sesión cerrada.");
  });

  // Configuración: tema claro / oscuro (el interruptor aparece aquí y en «Cuenta»).
  $("#open-settings").addEventListener("click", () => {
    setTheme(currentTheme(), false);
    renderInstallSection();
    els.settingsDialog.showModal();
  });
  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-theme-switch]")) setTheme(event.target.checked ? "dark" : "light");
  });

  // Inicio de sesión
  $("#login-email-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    withBusy(form, async () => {
      const email = String(new FormData(form).get("email")).trim().toLowerCase();
      if (!PUCE_EMAIL.test(email)) throw new Error("Usa tu correo institucional @puce.edu.ec.");
      await sendCode(email);
    });
  });
  $("#login-code-form").addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy(event.currentTarget, verifyCode);
  });
  // Acepta el código pegado con espacios o guiones y entra solo al completar los 6 dígitos.
  $("#login-code").addEventListener("input", (event) => {
    const input = event.currentTarget;
    const digits = input.value.replace(/\D/g, "").slice(0, 6);
    if (input.value !== digits) input.value = digits;
    setLoginError("");
    if (digits.length === 6) $("#login-code-form").requestSubmit();
  });
  $("#login-resend").addEventListener("click", resendCode);
  $("#login-back").addEventListener("click", useOtherEmail);

  // Catálogo y tiendas
  els.search.addEventListener("input", renderProducts);
  els.categories.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-category]");
    if (chip) selectCategory(chip.dataset.category);
  });
  $("#reset-filters").addEventListener("click", () => {
    els.search.value = "";
    selectCategory("Todos");
  });
  const onCatalogClick = (event) => {
    const favoriteButton = event.target.closest("[data-favorite]");
    if (favoriteButton) {
      toggleFavorite(favoriteButton.dataset.favorite);
      return;
    }
    const orderButton = event.target.closest("[data-order]");
    if (orderButton && !orderButton.disabled) openOrder(orderButton.dataset.order);
  };
  els.grid.addEventListener("click", onCatalogClick);
  els.storeContent.addEventListener("click", onCatalogClick);

  // Calculadora y formularios
  $("#calc-price").addEventListener("input", updateCalculator);
  $("#publish-price").addEventListener("input", updatePublishNet);
  $("#order-quantity").addEventListener("input", updateOrderTotal);
  $("#publish-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.reportValidity()) withBusy(form, () => submitProduct(form));
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
  const PANEL_FORMS = { "account-form": saveAccount, "store-form": saveStore, "admin-settings-form": saveAdminSettings };
  els.panelContent.addEventListener("submit", (event) => {
    const form = event.target;
    const save = PANEL_FORMS[form.id];
    if (!save) return;
    event.preventDefault();
    if (form.reportValidity()) withBusy(form, () => save(form));
  });
  els.panelContent.addEventListener("change", (event) => {
    if (event.target.id === "seller-switch") toggleSeller(event.target);
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
    if (event.key === THEME_KEY && event.newValue) setTheme(event.newValue, false);
  });
}

async function init() {
  setTheme(currentTheme(), false);
  bindEvents();
  updateCalculator();
  updatePublishNet();
  renderInstallSection();
  if (!isConfigured) {
    $("#setup-notice").classList.remove("hidden");
    els.count.textContent = "";
    route();
    hideSplash();
    return;
  }
  loadSettings();
  pickupReady = loadPickupPoints();
  try {
    await initAuth();
  } catch (error) {
    console.error(error);
    showToast(errorMessage(error), true);
  }
  route();
  hideSplash();
  window.setTimeout(updateInstallBanner, 2500);
  await loadCatalog();
  loadStores();
}

init();
