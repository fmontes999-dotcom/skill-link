"use strict";

/* =====================================================================
   Skill-Link · instalación como app (PWA)
   Lo usan la app (index.html) y la página de descarga (instalar.html):
   registra el service worker, guarda el aviso de instalación del navegador
   y da la guía para iPhone y Android.
   ===================================================================== */

(() => {
  let deferredPrompt = null;
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error(error);
    }
  });

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function platform() {
    const ua = navigator.userAgent || "";
    const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (iOS) return "ios";
    if (/Android/i.test(ua)) return "android";
    return "desktop";
  }

  // En iPhone solo Safari puede agregar la app a la pantalla de inicio (salvo iOS muy reciente).
  function isIosSafari() {
    const ua = navigator.userAgent || "";
    return platform() === "ios" && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA|Instagram|FBAN|FBAV|WhatsApp/i.test(ua);
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    notify();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });

  async function prompt() {
    if (!deferredPrompt) return "unavailable";
    const event = deferredPrompt;
    deferredPrompt = null;
    event.prompt();
    const choice = await event.userChoice.catch(() => null);
    notify();
    return choice?.outcome || "dismissed";
  }

  function guideHtml(target = platform()) {
    if (target === "ios") {
      return `
        <ol class="install-steps">
          <li>Abre esta página en <strong>Safari</strong>${platform() === "ios" && !isIosSafari() ? " (copia el enlace y pégalo en Safari)" : ""}.</li>
          <li>Toca el botón <strong>Compartir</strong> <span class="install-icon" aria-hidden="true">⬆︎</span> (el cuadrado con una flecha).</li>
          <li>Elige <strong>«Agregar a pantalla de inicio»</strong> (o «Agregar a inicio»).</li>
          <li>Toca <strong>Agregar</strong>. Skill-Link aparecerá con su ícono junto a tus apps.</li>
        </ol>`;
    }
    if (target === "android") {
      return `
        <ol class="install-steps">
          <li>Abre esta página en <strong>Chrome</strong>.</li>
          <li>Toca <strong>«Instalar Skill-Link»</strong>. Si no aparece, abre el menú <strong>⋮</strong> y elige <strong>«Instalar app»</strong> o <strong>«Agregar a la pantalla principal»</strong>.</li>
          <li>Confirma con <strong>Instalar</strong>. Skill-Link aparecerá con su ícono junto a tus apps.</li>
        </ol>`;
    }
    return `
      <ol class="install-steps">
        <li>En <strong>Chrome</strong> o <strong>Edge</strong>, toca <strong>«Instalar Skill-Link»</strong> o el ícono de instalar en la barra de direcciones.</li>
        <li>En el celular es mejor: abre el enlace allí, o escanea el código QR de la página de descarga.</li>
      </ol>`;
  }

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((error) => console.warn("No se pudo registrar el service worker.", error));
    });
  }

  window.SkillLinkInstall = {
    isStandalone,
    platform,
    isIosSafari,
    prompt,
    guideHtml,
    canPrompt: () => Boolean(deferredPrompt),
    onChange: (listener) => listeners.add(listener),
  };
})();
