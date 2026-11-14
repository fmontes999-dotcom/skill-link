# Skill-Link

Plataforma web exclusiva de la comunidad PUCE que conecta a emprendedores estudiantiles con compradores (estudiantes, profesores y personal administrativo).

**Modelo de negocio (IPE 2026-02):** publicar es gratis. Skill-Link cobra al emprendedor una **comisión del 8% al 10% solo por cada venta concretada** desde la aplicación. No hay mensualidades, suscripciones ni recargas.

**Pagos:** con **QR de Banco Pichincha** (Banca Móvil o DeUna).

**Cuentas:** todos entran como compradores. Quien quiere vender activa **«Quiero vender»** en **Cuenta** y crea su **tienda**: logo, nombre del emprendimiento, eslogan, descripción, carrera o facultad (opcional), redes sociales, días y horarios, y Puntos Link donde entrega. Ahí también arma su **catálogo**: cada producto tiene su foto, descripción, categoría y precio, y se puede editar, pausar o eliminar sin volver a publicarlo. El comprador puede abrir la tienda desde cualquier producto y pedir desde ahí.

**Precio mínimo de venta:** $1.00. El administrador puede cambiarlo, y la base de datos lo valida al crear y al editar un producto.

**Tema claro y oscuro:** se cambia en **Configuración** (el ícono de engranaje) o en **Cuenta**. El navegador lo recuerda. Los colores predominantes son azules.

- **Hosting:** Render (Static Site)
- **Base de datos, autenticación y archivos:** Supabase

---

## Cómo funciona una venta

| Paso | Quién | Qué pasa en la app |
|---|---|---|
| 1. Pedido | Comprador | Elige un producto, desde el catálogo o desde la tienda del emprendedor, y envía el pedido. |
| 2. Aceptación | Emprendedor | Acepta y fija el **Punto Link** y la hora (o rechaza). |
| 3. Pago | Comprador | Ve el **QR de cobro de Banco Pichincha del emprendedor**, paga desde su app bancaria y escribe el número de comprobante. |
| 4. Entrega | Ambos | En el Punto Link, el comprador muestra su **QR de entrega** y el emprendedor lo escanea (o escribe el código de 6 caracteres). |
| 5. Venta registrada | Sistema | El pedido queda «Entregado» y se genera la **comisión** (8–10%). |
| 6. Pago de comisiones | Emprendedor | En su panel ve lo que debe y paga escaneando el **QR de Skill-Link**. Luego reporta el comprobante. |
| 7. Verificación | Administrador | Revisa el comprobante en la cuenta de Skill-Link y aprueba o rechaza el pago. |

Reglas del Word implementadas:

- La comisión se genera **solo** cuando se confirma la entrega con el QR.
- Un pedido cancelado o rechazado antes de la entrega **no genera comisión**.
- Para devoluciones, el administrador puede **anular** una comisión indicando el motivo.
- El porcentaje (8%, 9% o 10%) se configura en el panel de administración y se guarda en cada venta.
- Las reseñas solo se pueden dejar sobre pedidos entregados (una por pedido).
- Ningún producto puede costar menos que el **precio mínimo** ($1.00 al inicio). Si el administrador lo sube, los productos más baratos quedan pausados hasta que su dueño corrija el precio.
- Solo pueden crear cuenta los correos `@puce.edu.ec`. Esto se valida también en la base de datos, no solo en la página.

> **Importante:** el pago **no se verifica automáticamente** con Banco Pichincha. Para eso se necesitaría un convenio comercial o una pasarela de pagos con API. La verificación es manual: el emprendedor revisa su app bancaria antes de entregar, y el administrador revisa los pagos de comisiones. En el Word esto figura como «pasarela integrada» para una etapa posterior.

---

## Archivos

```
index.html          Página (catálogo, tiendas, cómo funciona, comisión, panel)
styles.css          Estilos (azules, tema claro y oscuro)
app.js              Lógica: sesión con código, catálogo, tiendas, pedidos, QR, comisiones, administración
config.example.js   Plantilla de configuración local (copiar como config.js)
supabase/schema.sql Tablas, seguridad (RLS), funciones y buckets de Supabase
scripts/build.mjs   Build de Render: genera dist/ y config.js con las variables de entorno
render.yaml         Blueprint de Render
```

---

## 1. Configurar Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. Ve a **SQL Editor → New query**, pega todo el contenido de `supabase/schema.sql` y presiona **Run**. Se crean:
   - las tablas,
   - la seguridad por filas (RLS),
   - los Puntos Link de ejemplo,
   - los buckets `product-images` (público) y `payment-qr` (privado).
3. Ve a **Authentication → Sign In / Providers** y confirma que **Email** esté activado.
4. Ve a **Authentication → URL Configuration**:
   - **Site URL:** la URL de Render (por ejemplo `https://skill-link.onrender.com`).
   - **Redirect URLs:** agrega esa misma URL y, para pruebas locales, `http://localhost:5500`.
5. **Correo SMTP propio (obligatorio para usar códigos).** El correo incluido en Supabase solo envía 2 correos por hora y no deja editar las plantillas. Configura un SMTP en **Authentication → Emails → SMTP Settings** (Gmail con contraseña de aplicación, Brevo o Resend).
   *En el proyecto actual ya está conectado un Gmail, con un límite de 100 correos por hora; Gmail permite unos 500 al día.*
6. **Plantillas con código y sin enlace.** En **Authentication → Emails → Templates**, las plantillas **Magic Link** y **Confirm signup** deben traer solo el código `{{ .Token }}`, sin `{{ .ConfirmationURL }}`:

   ```html
   <h2>Tu código de acceso</h2>
   <p>Escribe este código en la página de Skill-Link: <strong>{{ .Token }}</strong></p>
   <p>Vence en 15 minutos. Usa siempre el del correo más reciente.</p>
   ```

   ⚠️ **No pongas el enlace.** El filtro de seguridad del correo PUCE (Microsoft 365) abre los enlaces segundos después de que llega el correo, para revisarlos. Al abrirlo gasta el código de un solo uso, y la persona recibe «código vencido o inválido» aunque lo escriba bien. Esto pasó el 13 de noviembre de 2026 y está en los registros de Supabase. En **Sign In / Providers → Email**, pon la duración del código (*Email OTP Expiration*) en 900 segundos (15 minutos).
7. Copia los datos de conexión desde **Project Settings → API**. Los vas a usar en Render:
   - **Project URL**
   - **clave pública** `anon` / `publishable`

   ⚠️ **Nunca uses la clave `service_role` / `secret`.** El build la rechaza si la pones por error.

### Nombrar administradores

Después de que la persona haya ingresado al menos una vez, ejecuta en el SQL Editor:

```sql
update public.profiles set role = 'admin' where email = 'correo@puce.edu.ec';
```

El administrador ve la pestaña **Administración** en su panel. Desde ahí:

1. Sube el **QR de cobro de Banco Pichincha de Skill-Link**.
2. Escribe el titular de la cuenta.
3. Elige el porcentaje de comisión.
4. Define el **precio mínimo de venta** (al inicio, $1.00).

### Puntos Link

Los tres Puntos Link del script son ejemplos y hay que confirmarlos con la PUCE. Se editan en **Table Editor → pickup_points**.

---

## 2. Publicar en Render

1. Sube esta carpeta a un repositorio de GitHub. El `.gitignore` ya excluye:
   - `config.js` y `dist/`,
   - los `.docx` del curso, que tienen los nombres del equipo.
2. En Render elige una de estas opciones:
   - **New → Blueprint** y selecciona el repositorio. Usa `render.yaml` y te pide las variables.
   - **New → Static Site**, con esta configuración:
     - Build Command: `node scripts/build.mjs`
     - Publish Directory: `dist`
3. Agrega las variables de entorno:
   - `SUPABASE_URL` = Project URL de Supabase
   - `SUPABASE_ANON_KEY` = clave pública anon/publishable
4. Despliega. Al final, copia la URL de Render en **Site URL** y **Redirect URLs** de Supabase (paso 1.4).

El escáner de QR usa la cámara, que solo funciona en HTTPS (Render ya lo da) o en `localhost`.

---

## 3. Probar en tu computadora

1. Copia `config.example.js` como `config.js` y pon tu URL y tu clave anon.
2. Sirve la carpeta con un servidor local. Por ejemplo, con la extensión **Live Server** de VS Code queda en `http://localhost:5500`.
3. Para probar una venta completa necesitas **dos cuentas PUCE**, una que venda y otra que compre:
   1. Vendedor: en **Cuenta**, activa **«Quiero vender»**. En **Mi tienda**, completa el perfil del emprendimiento, sube tu QR de cobro y agrega uno o varios productos.
   2. Comprador: pide el producto.
   3. Vendedor: acepta el pedido (Punto Link + hora).
   4. Comprador: «Pagar con QR» → escribe el comprobante → «Mostrar QR de entrega».
   5. Vendedor: «Escanear QR de entrega» (o escribe el código de 6 caracteres) → la venta queda registrada con su comisión.
   6. Vendedor: en **Comisiones** → «Pagar con QR» → reporta el comprobante.
   7. Administrador: en **Administración** → aprueba el pago.

---

## Seguridad

- Las tiendas son públicas solo mientras su dueño tiene activado «Quiero vender». Cada persona edita únicamente su propia tienda, y sube logos y fotos solo a su carpeta.
- Toda la información está protegida con **Row Level Security**:
  - cada persona ve solo sus pedidos, ventas y comisiones;
  - el QR de cobro de un emprendedor solo lo puede abrir quien tiene un pedido aceptado con él.
- Los cambios de estado (aceptar, pagar, entregar, comisiones) solo se hacen mediante funciones de la base de datos que validan quién hace cada cosa. Nadie puede marcar una venta como entregada sin el código del comprador. Tampoco puede cambiar el monto de una comisión.
- El código de entrega solo lo ve el comprador. Tras 5 intentos fallidos se bloquea.
- La clave que va en el navegador es la pública (anon). Por eso las reglas de seguridad viven en Supabase y no en la página.
