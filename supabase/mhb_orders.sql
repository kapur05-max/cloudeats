-- Mum's Healthy Bites — order tracking
--
-- Run this ONCE in Supabase: SQL Editor -> New query -> paste -> Run.
--
-- Every paid order is saved here automatically by the stripe-webhook
-- function. You can view and update orders in Supabase under
-- Table Editor -> mhb_orders (change `status` as you pack and post them,
-- and put the Royal Mail tracking number in `tracking_ref`).
--
-- The table is private: row level security is on and there are no public
-- policies, so only the server (using the secret key) can read or write it.

create table if not exists public.mhb_orders (
  id                  uuid primary key default gen_random_uuid(),
  stripe_session_id   text not null unique,
  stripe_payment_intent text,
  status              text not null default 'paid',   -- paid -> packed -> posted -> delivered (or refunded / cancelled)
  email               text,
  customer_name       text,
  phone               text,
  shipping_name       text,
  shipping_address    jsonb,                          -- line1, line2, city, postal_code, country
  items               jsonb not null default '[]'::jsonb, -- [{sku, name, qty, unit_pence, line_pence}]
  subtotal_pence      integer,
  discount_pence      integer,
  delivery_pence      integer,
  total_pence         integer,
  tracking_ref        text,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.mhb_orders enable row level security;

create index if not exists mhb_orders_created_at_idx on public.mhb_orders (created_at desc);
create index if not exists mhb_orders_status_idx on public.mhb_orders (status);
