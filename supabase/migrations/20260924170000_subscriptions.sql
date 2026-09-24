-- Monthly subscriptions, written by api/stripe/webhook.mjs (service_role).
-- A user has access while one of their rows is 'active' or 'trialing'.
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  email text,
  stripe_customer_id text,
  stripe_subscription_id text not null unique,
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index subscriptions_user_id_idx on public.subscriptions (user_id);

alter table public.subscriptions enable row level security;

create policy "Users can read their own subscriptions"
  on public.subscriptions for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- This project doesn't auto-grant table privileges to the API roles.
grant select on public.subscriptions to authenticated;
grant select, insert, update on public.subscriptions to service_role;
