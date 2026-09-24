-- One row per Stripe Checkout Session from the payment link. A user has
-- access while they have a row with status = 'paid'.
create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  email text,
  stripe_checkout_session_id text not null unique,
  stripe_payment_intent_id text,
  stripe_customer_id text,
  amount_total integer,
  currency text,
  status text not null check (status in ('paid', 'refunded', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index purchases_user_id_idx on public.purchases (user_id);
create index purchases_payment_intent_idx on public.purchases (stripe_payment_intent_id);

-- Users can read their own purchases; only the service role (the
-- stripe-webhook edge function) writes.
alter table public.purchases enable row level security;

create policy "Users can read their own purchases"
  on public.purchases for select
  to authenticated
  using (user_id = (select auth.uid()));

-- This project doesn't auto-grant table privileges to the API roles.
revoke all on public.purchases from anon, authenticated;
grant select on public.purchases to authenticated;
grant select, insert, update on public.purchases to service_role;

-- The Stripe webhook signing secret lives in Vault under the name
-- 'stripe_webhook_secret'; only the service role can read it.
create function public.get_stripe_webhook_secret()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets
  where name = 'stripe_webhook_secret'
  limit 1;
$$;

revoke execute on function public.get_stripe_webhook_secret() from public, anon, authenticated;
grant execute on function public.get_stripe_webhook_secret() to service_role;

-- Looks up a user id by email, for checkouts missing client_reference_id.
create function public.find_user_id_by_email(p_email text)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;

revoke execute on function public.find_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.find_user_id_by_email(text) to service_role;
