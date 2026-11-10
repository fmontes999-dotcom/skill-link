// Genera la carpeta dist/ que publica Render (Static Site).
// Lee SUPABASE_URL y SUPABASE_ANON_KEY de las variables de entorno de Render
// y crea dist/config.js. No usa dependencias externas.
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";

const FILES = ["index.html", "styles.css", "app.js"];
const OUT = "dist";

const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const key = (process.env.SUPABASE_ANON_KEY || "").trim();

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// Impide publicar por error la clave secreta (service_role / sb_secret_...).
function isSecretKey(value) {
  if (value.startsWith("sb_secret_")) return true;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

// Sin ninguna de las dos variables se publica en modo vista previa: la página
// carga y muestra el aviso "Falta conectar Supabase" (sin catálogo ni sesión).
const preview = !url && !key;
if (preview) {
  console.warn("⚠ Sin SUPABASE_URL ni SUPABASE_ANON_KEY: se publica en modo vista previa.");
} else {
  if (!url || !key) fail("Falta SUPABASE_URL o SUPABASE_ANON_KEY en Render (pon las dos).");
  if (!/^https:\/\/[^\s]+$/.test(url)) fail("SUPABASE_URL debe ser la URL del proyecto (https://xxxx.supabase.co).");
  if (isSecretKey(key)) fail("Esa es la clave secreta (service_role). Usa la clave pública anon/publishable.");
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const file of FILES) await copyFile(file, `${OUT}/${file}`);
await writeFile(
  `${OUT}/config.js`,
  `window.SKILL_LINK_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key }, null, 2)};\n`,
);
console.log(`✓ ${OUT}/ generado (${FILES.length + 1} archivos).`);
