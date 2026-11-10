-- =====================================================================
-- Skill-Link · Esquema de base de datos para Supabase
--
-- Modelo de negocio (IPE 2026-02): comisión del 8% al 10% únicamente por
-- ventas concretadas desde la plataforma. Sin mensualidades ni recargas.
--
-- Flujo de pago con QR de Banco Pichincha:
--   1. El comprador hace un pedido y el emprendedor lo acepta (Punto Link + hora).
--   2. El comprador paga al emprendedor escaneando el QR de cobro de Banco
--      Pichincha que el emprendedor subió a su perfil, y reporta el comprobante.
--   3. En el Punto Link, el emprendedor escanea el QR de entrega del comprador:
--      la venta queda registrada y se genera la comisión.
--   4. El emprendedor paga sus comisiones acumuladas escaneando el QR de
--      Skill-Link; un administrador verifica el comprobante y lo aprueba.
--
-- Uso: Supabase > SQL Editor > New query > pegar todo el archivo > Run.
-- Se puede volver a ejecutar sin perder datos.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------

-- Código aleatorio legible (sin 0/O ni 1/I). 32 símbolos → sin sesgo.
create or replace function public.random_code(len int default 6)
returns text
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := gen_random_bytes(len);
  result text := '';
begin
  for i in 0 .. len - 1 loop
    result := result || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return result;
end;
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------

-- Configuración global (una sola fila).
create table if not exists public.platform_settings (
  id boolean primary key default true check (id),
  commission_rate numeric(4,3) not null default 0.100
    check (commission_rate between 0.080 and 0.100),
  payment_qr_path text,   -- QR de cobro de Banco Pichincha de Skill-Link (bucket payment-qr)
  payment_holder text,    -- titular de la cuenta de Skill-Link
  updated_at timestamptz not null default now(),
  check (payment_qr_path is null or payment_qr_path like 'platform/%')
);
insert into public.platform_settings (id) values (true) on conflict (id) do nothing;

-- Perfil de cada usuario (se crea automáticamente al registrarse).
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  full_name text not null default '' check (char_length(full_name) <= 60),
  phone text check (phone is null or phone ~ '^[0-9+ ]{7,16}$'),
  payment_qr_path text,   -- QR de cobro de Banco Pichincha del emprendedor
  payment_holder text check (payment_holder is null or char_length(payment_holder) <= 60),
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  check (payment_qr_path is null or payment_qr_path like id::text || '/%')
);

-- Puntos Link: lugares y horarios fijos de entrega dentro del campus.
create table if not exists public.pickup_points (
  id serial primary key,
  name text not null,
  schedule text not null,
  active boolean not null default true
);

-- Publicaciones (productos o servicios).
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 2 and 60),
  category text not null check (category in ('Comida', 'Arte y regalos', 'Servicios', 'Bienestar')),
  price numeric(10,2) not null check (price > 0 and price < 10000),
  description text not null check (char_length(description) between 1 and 300),
  image_path text,
  pickup_point boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (image_path is null or image_path like seller_id::text || '/%')
);
create index if not exists products_seller_idx on public.products (seller_id);

-- Pedidos. Solo se modifican mediante las funciones RPC de más abajo.
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default public.random_code(6),
  product_id uuid references public.products (id) on delete set null,
  product_name text not null,
  seller_id uuid not null references public.profiles (id) on delete restrict,
  buyer_id uuid not null references public.profiles (id) on delete restrict,
  quantity int not null check (quantity between 1 and 20),
  unit_price numeric(10,2) not null check (unit_price > 0),
  total numeric(10,2) not null check (total > 0),
  message text check (message is null or char_length(message) <= 300),
  status text not null default 'pendiente'
    check (status in ('pendiente', 'aceptado', 'completado', 'rechazado', 'cancelado')),
  pickup_point text,
  meeting_at timestamptz,
  payment_reference text,       -- número de comprobante reportado por el comprador
  payment_reported_at timestamptz,
  completed_at timestamptz,
  closed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (buyer_id <> seller_id)
);
create index if not exists orders_buyer_idx on public.orders (buyer_id, created_at desc);
create index if not exists orders_seller_idx on public.orders (seller_id, created_at desc);

drop trigger if exists orders_touch_updated_at on public.orders;
create trigger orders_touch_updated_at
  before update on public.orders
  for each row execute function public.touch_updated_at();

-- Código secreto de entrega: solo lo ve el comprador (se muestra como QR).
create table if not exists public.order_delivery_codes (
  order_id uuid primary key references public.orders (id) on delete cascade,
  buyer_id uuid not null references public.profiles (id) on delete cascade,
  code text not null default public.random_code(6),
  failed_attempts int not null default 0
);

-- Pagos de comisiones del emprendedor a Skill-Link (QR de Skill-Link).
create table if not exists public.commission_payments (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles (id) on delete restrict,
  amount numeric(10,2) not null check (amount > 0),
  reference text not null check (char_length(reference) between 3 and 40),
  status text not null default 'en_revision'
    check (status in ('en_revision', 'aprobado', 'rechazado')),
  review_note text,
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists commission_payments_seller_idx on public.commission_payments (seller_id, created_at desc);

-- Comisión generada por cada venta concretada.
create table if not exists public.commissions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders (id) on delete restrict,
  seller_id uuid not null references public.profiles (id) on delete restrict,
  sale_amount numeric(10,2) not null,
  rate numeric(4,3) not null,
  amount numeric(10,2) not null,
  status text not null default 'pendiente'
    check (status in ('pendiente', 'en_revision', 'pagada', 'anulada')),
  payment_id uuid references public.commission_payments (id),
  void_reason text,
  created_at timestamptz not null default now()
);
create index if not exists commissions_seller_idx on public.commissions (seller_id, created_at desc);
create index if not exists commissions_payment_idx on public.commissions (payment_id);

-- Reseñas: solo de pedidos completados, una por pedido.
create table if not exists public.reviews (
  order_id uuid primary key references public.orders (id) on delete cascade,
  product_id uuid references public.products (id) on delete set null,
  seller_id uuid not null references public.profiles (id) on delete cascade,
  buyer_id uuid not null references public.profiles (id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 300),
  created_at timestamptz not null default now()
);
create index if not exists reviews_product_idx on public.reviews (product_id);

-- Puntos Link de ejemplo (confirmar lugares y horarios reales con la PUCE).
insert into public.pickup_points (name, schedule)
select v.name, v.schedule
from (values
  ('Punto Link · Plaza central', 'Lunes a viernes · 10:00–10:30 y 13:00–13:30'),
  ('Punto Link · Biblioteca', 'Lunes a viernes · 12:00–12:30'),
  ('Punto Link · Cafetería', 'Lunes a viernes · 16:00–16:30')
) as v(name, schedule)
where not exists (select 1 from public.pickup_points);

-- ---------------------------------------------------------------------
-- Funciones auxiliares de seguridad
-- ---------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ¿El usuario actual comparte algún pedido con este perfil?
create or replace function public.shares_order(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.orders
    where (buyer_id = auth.uid() and seller_id = p_other)
       or (seller_id = auth.uid() and buyer_id = p_other)
  );
$$;

-- ¿Puede el usuario actual ver la imagen del QR guardada en esta carpeta?
-- Carpeta = id del emprendedor, o "platform" para el QR de Skill-Link.
create or replace function public.can_view_payment_qr(p_folder text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_folder = auth.uid()::text
      or p_folder = 'platform'
      or public.is_admin()
      or exists (
        select 1 from public.orders
        where buyer_id = auth.uid()
          and seller_id::text = p_folder
          and status in ('aceptado', 'completado')
      );
$$;

-- Solo correos institucionales PUCE pueden crear cuenta.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is null or lower(new.email) !~ '@([a-z0-9-]+\.)*puce\.edu\.ec$' then
    raise exception 'Solo se permiten correos institucionales de la PUCE (@puce.edu.ec).';
  end if;
  insert into public.profiles (id, email)
  values (new.id, lower(new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Row Level Security y permisos
-- ---------------------------------------------------------------------

alter table public.platform_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.pickup_points enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_delivery_codes enable row level security;
alter table public.commission_payments enable row level security;
alter table public.commissions enable row level security;
alter table public.reviews enable row level security;

-- Se parte de cero y se concede solo lo necesario.
revoke all on
  public.platform_settings, public.profiles, public.pickup_points, public.products,
  public.orders, public.order_delivery_codes, public.commission_payments,
  public.commissions, public.reviews
from anon, authenticated;

grant select on public.platform_settings to anon, authenticated;
grant update (commission_rate, payment_qr_path, payment_holder, updated_at)
  on public.platform_settings to authenticated;

grant select on public.pickup_points to anon, authenticated;

grant select on public.profiles to authenticated;
grant update (full_name, phone, payment_qr_path, payment_holder) on public.profiles to authenticated;

grant select, insert, delete on public.products to authenticated;
grant update (name, category, price, description, image_path, pickup_point, active)
  on public.products to authenticated;

grant select on
  public.orders, public.order_delivery_codes, public.commission_payments,
  public.commissions, public.reviews
to authenticated;

-- platform_settings
drop policy if exists settings_read on public.platform_settings;
create policy settings_read on public.platform_settings
  for select using (true);
drop policy if exists settings_admin_update on public.platform_settings;
create policy settings_admin_update on public.platform_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- pickup_points
drop policy if exists pickup_points_read on public.pickup_points;
create policy pickup_points_read on public.pickup_points
  for select using (active);

-- profiles: el propio, el de quien comparte un pedido contigo, o admin.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin() or public.shares_order(id));
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- products: para vender se necesita nombre y QR de cobro en el perfil.
drop policy if exists products_read on public.products;
create policy products_read on public.products
  for select to authenticated
  using (active or seller_id = auth.uid() or public.is_admin());
drop policy if exists products_insert_own on public.products;
create policy products_insert_own on public.products
  for insert to authenticated
  with check (
    seller_id = auth.uid()
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and full_name <> '' and payment_qr_path is not null
    )
  );
drop policy if exists products_update_own on public.products;
create policy products_update_own on public.products
  for update to authenticated
  using (seller_id = auth.uid()) with check (seller_id = auth.uid());
drop policy if exists products_delete_own on public.products;
create policy products_delete_own on public.products
  for delete to authenticated
  using (seller_id = auth.uid() or public.is_admin());

-- orders y tablas relacionadas: solo lectura; los cambios van por RPC.
drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders
  for select to authenticated
  using (buyer_id = auth.uid() or seller_id = auth.uid() or public.is_admin());

drop policy if exists delivery_codes_read on public.order_delivery_codes;
create policy delivery_codes_read on public.order_delivery_codes
  for select to authenticated
  using (buyer_id = auth.uid());

drop policy if exists commissions_read on public.commissions;
create policy commissions_read on public.commissions
  for select to authenticated
  using (seller_id = auth.uid() or public.is_admin());

drop policy if exists commission_payments_read on public.commission_payments;
create policy commission_payments_read on public.commission_payments
  for select to authenticated
  using (seller_id = auth.uid() or public.is_admin());

drop policy if exists reviews_read on public.reviews;
create policy reviews_read on public.reviews
  for select to authenticated
  using (buyer_id = auth.uid() or seller_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------
-- Catálogo público (solo columnas seguras, nombre abreviado del vendedor)
-- ---------------------------------------------------------------------

create or replace function public.get_catalog()
returns table (
  id uuid,
  name text,
  category text,
  price numeric,
  description text,
  image_path text,
  pickup_point boolean,
  seller_id uuid,
  seller_name text,
  rating numeric,
  reviews_count bigint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id, p.name, p.category, p.price, p.description, p.image_path, p.pickup_point, p.seller_id,
    case
      when split_part(trim(pr.full_name), ' ', 2) <> ''
        then split_part(trim(pr.full_name), ' ', 1) || ' ' || left(split_part(trim(pr.full_name), ' ', 2), 1) || '.'
      else coalesce(nullif(trim(pr.full_name), ''), 'Emprendedor PUCE')
    end as seller_name,
    round(avg(r.rating)::numeric, 1) as rating,
    count(r.order_id) as reviews_count,
    p.created_at
  from public.products p
  join public.profiles pr on pr.id = p.seller_id
  left join public.reviews r on r.product_id = p.id
  where p.active
  group by p.id, pr.full_name
  order by p.created_at desc
  limit 300;
$$;

-- ---------------------------------------------------------------------
-- Pedidos (RPC)
-- ---------------------------------------------------------------------

create or replace function public.create_order(p_product_id uuid, p_quantity int default 1, p_message text default null)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_product public.products;
  v_order public.orders;
begin
  if v_uid is null then
    raise exception 'Inicia sesión con tu correo PUCE para hacer un pedido.';
  end if;
  select * into v_product from public.products where id = p_product_id and active;
  if not found then
    raise exception 'Este producto ya no está disponible.';
  end if;
  if v_product.seller_id = v_uid then
    raise exception 'No puedes pedir tu propio producto.';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    raise exception 'La cantidad debe estar entre 1 y 20.';
  end if;
  if (select count(*) from public.orders where buyer_id = v_uid and status = 'pendiente') >= 10 then
    raise exception 'Tienes demasiados pedidos pendientes. Espera a que los emprendedores respondan.';
  end if;

  insert into public.orders (product_id, product_name, seller_id, buyer_id, quantity, unit_price, total, message)
  values (
    v_product.id, v_product.name, v_product.seller_id, v_uid, p_quantity, v_product.price,
    round(v_product.price * p_quantity, 2),
    nullif(left(trim(coalesce(p_message, '')), 300), '')
  )
  returning * into v_order;

  insert into public.order_delivery_codes (order_id, buyer_id) values (v_order.id, v_uid);
  return v_order;
end;
$$;

-- El emprendedor acepta (con Punto Link y hora) o rechaza.
create or replace function public.respond_order(
  p_order_id uuid,
  p_accept boolean,
  p_pickup_point text default null,
  p_meeting_at timestamptz default null,
  p_reason text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders
  where id = p_order_id and seller_id = auth.uid()
  for update;
  if not found then
    raise exception 'Pedido no encontrado.';
  end if;
  if v_order.status <> 'pendiente' then
    raise exception 'Este pedido ya fue respondido.';
  end if;

  if p_accept then
    if coalesce(trim(p_pickup_point), '') = '' then
      raise exception 'Elige un Punto Link o el lugar de entrega.';
    end if;
    if p_meeting_at is null or p_meeting_at < now() - interval '1 hour' then
      raise exception 'Indica una fecha y hora de entrega válida.';
    end if;
    update public.orders
    set status = 'aceptado', pickup_point = left(trim(p_pickup_point), 120), meeting_at = p_meeting_at
    where id = p_order_id
    returning * into v_order;
  else
    update public.orders
    set status = 'rechazado', closed_reason = coalesce(nullif(left(trim(coalesce(p_reason, '')), 200), ''), 'Rechazado por el emprendedor')
    where id = p_order_id
    returning * into v_order;
  end if;
  return v_order;
end;
$$;

-- Cancelación antes de la entrega: no genera comisión.
create or replace function public.cancel_order(p_order_id uuid, p_reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders
  where id = p_order_id and (buyer_id = auth.uid() or seller_id = auth.uid())
  for update;
  if not found then
    raise exception 'Pedido no encontrado.';
  end if;
  if v_order.status not in ('pendiente', 'aceptado') then
    raise exception 'Solo se pueden cancelar pedidos que aún no se han entregado.';
  end if;
  update public.orders
  set status = 'cancelado',
      closed_reason = coalesce(
        nullif(left(trim(coalesce(p_reason, '')), 200), ''),
        case when auth.uid() = v_order.buyer_id then 'Cancelado por el comprador' else 'Cancelado por el emprendedor' end
      )
  where id = p_order_id
  returning * into v_order;
  return v_order;
end;
$$;

-- El comprador reporta el comprobante del pago con QR de Banco Pichincha.
create or replace function public.report_payment(p_order_id uuid, p_reference text)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders
  where id = p_order_id and buyer_id = auth.uid()
  for update;
  if not found then
    raise exception 'Pedido no encontrado.';
  end if;
  if v_order.status <> 'aceptado' then
    raise exception 'Solo puedes pagar un pedido que el emprendedor ya aceptó.';
  end if;
  if char_length(trim(coalesce(p_reference, ''))) < 3 then
    raise exception 'Ingresa el número de comprobante de la transferencia.';
  end if;
  update public.orders
  set payment_reference = left(trim(p_reference), 40), payment_reported_at = now()
  where id = p_order_id
  returning * into v_order;
  return v_order;
end;
$$;

-- El emprendedor escanea el QR de entrega del comprador: venta concretada.
-- Devuelve JSON (en vez de lanzar error) para que se guarden los intentos fallidos.
create or replace function public.confirm_delivery(p_order_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_codes public.order_delivery_codes;
  v_rate numeric(4,3);
  v_amount numeric(10,2);
begin
  select * into v_order from public.orders
  where id = p_order_id and seller_id = auth.uid()
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Este QR no corresponde a uno de tus pedidos.');
  end if;
  if v_order.status = 'completado' then
    return jsonb_build_object('ok', false, 'error', 'Esta venta ya estaba registrada.');
  end if;
  if v_order.status <> 'aceptado' then
    return jsonb_build_object('ok', false, 'error', 'Primero debes aceptar el pedido.');
  end if;

  select * into v_codes from public.order_delivery_codes where order_id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'El pedido no tiene código de entrega.');
  end if;
  if v_codes.failed_attempts >= 5 then
    return jsonb_build_object('ok', false, 'error', 'Demasiados intentos fallidos. Contacta a soporte de Skill-Link.');
  end if;
  if upper(trim(coalesce(p_code, ''))) <> v_codes.code then
    update public.order_delivery_codes set failed_attempts = failed_attempts + 1 where order_id = p_order_id;
    return jsonb_build_object('ok', false, 'error', 'El código de entrega no coincide.');
  end if;

  select commission_rate into v_rate from public.platform_settings where id;
  v_amount := round(v_order.total * v_rate, 2);

  update public.orders set status = 'completado', completed_at = now() where id = p_order_id;
  insert into public.commissions (order_id, seller_id, sale_amount, rate, amount)
  values (p_order_id, v_order.seller_id, v_order.total, v_rate, v_amount);

  return jsonb_build_object(
    'ok', true,
    'code', v_order.code,
    'total', v_order.total,
    'rate', v_rate,
    'commission', v_amount
  );
end;
$$;

-- Reseña del comprador sobre un pedido completado.
create or replace function public.leave_review(p_order_id uuid, p_rating int, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders where id = p_order_id and buyer_id = auth.uid();
  if not found then
    raise exception 'Pedido no encontrado.';
  end if;
  if v_order.status <> 'completado' then
    raise exception 'Solo puedes calificar pedidos entregados.';
  end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'La calificación debe estar entre 1 y 5.';
  end if;
  insert into public.reviews (order_id, product_id, seller_id, buyer_id, rating, comment)
  values (v_order.id, v_order.product_id, v_order.seller_id, v_order.buyer_id, p_rating,
          nullif(left(trim(coalesce(p_comment, '')), 300), ''))
  on conflict (order_id) do nothing;
  if not found then
    raise exception 'Ya calificaste este pedido.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Comisiones (RPC)
-- ---------------------------------------------------------------------

-- El emprendedor reporta que pagó TODAS sus comisiones pendientes con el QR de Skill-Link.
create or replace function public.report_commission_payment(p_reference text)
returns public.commission_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_payment_id uuid;
  v_total numeric(10,2);
  v_payment public.commission_payments;
begin
  if v_uid is null then
    raise exception 'Inicia sesión.';
  end if;
  if char_length(trim(coalesce(p_reference, ''))) < 3 then
    raise exception 'Ingresa el número de comprobante de la transferencia.';
  end if;

  -- Monto provisional; se corrige con la suma exacta de las comisiones tomadas.
  insert into public.commission_payments (seller_id, amount, reference)
  values (v_uid, 0.01, left(trim(p_reference), 40))
  returning id into v_payment_id;

  update public.commissions
  set status = 'en_revision', payment_id = v_payment_id
  where seller_id = v_uid and status = 'pendiente';

  select coalesce(sum(amount), 0) into v_total from public.commissions where payment_id = v_payment_id;
  if v_total <= 0 then
    raise exception 'No tienes comisiones pendientes de pago.';
  end if;

  update public.commission_payments set amount = v_total where id = v_payment_id
  returning * into v_payment;
  return v_payment;
end;
$$;

-- Administrador: aprobar o rechazar un pago de comisiones.
create or replace function public.review_commission_payment(p_payment_id uuid, p_approve boolean, p_note text default null)
returns public.commission_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.commission_payments;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede revisar pagos.';
  end if;
  select * into v_payment from public.commission_payments where id = p_payment_id for update;
  if not found or v_payment.status <> 'en_revision' then
    raise exception 'Este pago ya fue revisado.';
  end if;

  update public.commission_payments
  set status = case when p_approve then 'aprobado' else 'rechazado' end,
      review_note = nullif(left(trim(coalesce(p_note, '')), 200), ''),
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = p_payment_id
  returning * into v_payment;

  if p_approve then
    update public.commissions set status = 'pagada'
    where payment_id = p_payment_id and status = 'en_revision';
  else
    update public.commissions set status = 'pendiente', payment_id = null
    where payment_id = p_payment_id and status = 'en_revision';
  end if;
  return v_payment;
end;
$$;

-- Administrador: anular una comisión (devolución o venta no concretada).
create or replace function public.void_commission(p_commission_id uuid, p_reason text)
returns public.commissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_commission public.commissions;
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede anular comisiones.';
  end if;
  if char_length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Indica el motivo (por ejemplo, devolución).';
  end if;
  select * into v_commission from public.commissions where id = p_commission_id for update;
  if not found then
    raise exception 'Comisión no encontrada.';
  end if;
  if v_commission.status = 'anulada' then
    raise exception 'Esta comisión ya está anulada.';
  end if;
  if v_commission.status = 'en_revision' then
    raise exception 'Primero revisa el pago asociado a esta comisión.';
  end if;
  update public.commissions
  set status = 'anulada', void_reason = left(trim(p_reason), 200)
  where id = p_commission_id
  returning * into v_commission;
  return v_commission;
end;
$$;

-- ---------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------

revoke execute on function public.random_code(int) from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.shares_order(uuid) from public, anon;
revoke execute on function public.can_view_payment_qr(text) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.shares_order(uuid) to authenticated;
grant execute on function public.can_view_payment_qr(text) to authenticated;

grant execute on function public.get_catalog() to anon, authenticated;

revoke execute on function public.create_order(uuid, int, text) from public, anon;
revoke execute on function public.respond_order(uuid, boolean, text, timestamptz, text) from public, anon;
revoke execute on function public.cancel_order(uuid, text) from public, anon;
revoke execute on function public.report_payment(uuid, text) from public, anon;
revoke execute on function public.confirm_delivery(uuid, text) from public, anon;
revoke execute on function public.leave_review(uuid, int, text) from public, anon;
revoke execute on function public.report_commission_payment(text) from public, anon;
revoke execute on function public.review_commission_payment(uuid, boolean, text) from public, anon;
revoke execute on function public.void_commission(uuid, text) from public, anon;

grant execute on function public.create_order(uuid, int, text) to authenticated;
grant execute on function public.respond_order(uuid, boolean, text, timestamptz, text) to authenticated;
grant execute on function public.cancel_order(uuid, text) to authenticated;
grant execute on function public.report_payment(uuid, text) to authenticated;
grant execute on function public.confirm_delivery(uuid, text) to authenticated;
grant execute on function public.leave_review(uuid, int, text) to authenticated;
grant execute on function public.report_commission_payment(text) to authenticated;
grant execute on function public.review_commission_payment(uuid, boolean, text) to authenticated;
grant execute on function public.void_commission(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Storage: imágenes de productos (públicas) y QR de cobro (privados)
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('product-images', 'product-images', true, 3145728, array['image/jpeg', 'image/png', 'image/webp']),
  ('payment-qr', 'payment-qr', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Imágenes de productos: cada usuario escribe solo en su carpeta (<uid>/...).
drop policy if exists "product images insert own" on storage.objects;
create policy "product images insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "product images update own" on storage.objects;
create policy "product images update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "product images delete own" on storage.objects;
create policy "product images delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- QR de cobro: el emprendedor en su carpeta; el admin en "platform".
drop policy if exists "payment qr insert" on storage.objects;
create policy "payment qr insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'payment-qr'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or ((storage.foldername(name))[1] = 'platform' and public.is_admin())
    )
  );
drop policy if exists "payment qr update" on storage.objects;
create policy "payment qr update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'payment-qr'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or ((storage.foldername(name))[1] = 'platform' and public.is_admin())
    )
  );
drop policy if exists "payment qr delete" on storage.objects;
create policy "payment qr delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'payment-qr'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or ((storage.foldername(name))[1] = 'platform' and public.is_admin())
    )
  );
-- Lectura: el dueño, el admin, el QR de Skill-Link, o un comprador con pedido aceptado.
drop policy if exists "payment qr read" on storage.objects;
create policy "payment qr read" on storage.objects
  for select to authenticated
  using (bucket_id = 'payment-qr' and public.can_view_payment_qr((storage.foldername(name))[1]));

-- ---------------------------------------------------------------------
-- Para nombrar administradores (después de que la persona inicie sesión):
--   update public.profiles set role = 'admin' where email = 'correo@puce.edu.ec';
-- ---------------------------------------------------------------------
