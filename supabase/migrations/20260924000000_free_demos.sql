-- One free generation per user before they have to pay. A row is 'pending'
-- while the demo generation runs and 'used' once it succeeded; a failed
-- generation deletes the row so the demo can be retried.
create table public.free_demos (
  user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null check (status in ('pending', 'used')),
  claimed_at timestamptz not null default now(),
  used_at timestamptz
);

alter table public.free_demos enable row level security;

create policy "Users can read their own free demo"
  on public.free_demos for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.free_demos from anon, authenticated;
grant select on public.free_demos to authenticated;
grant select, insert, update, delete on public.free_demos to service_role;

-- Atomically claims the caller's free demo. Returns false if it was already
-- used or is in progress. A pending claim older than 5 minutes (longer than
-- the generate function can run) is treated as abandoned and can be reclaimed.
create function public.claim_free_demo()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean;
begin
  if auth.uid() is null then
    return false;
  end if;

  insert into public.free_demos (user_id, status)
  values (auth.uid(), 'pending')
  on conflict (user_id) do update
    set status = 'pending', claimed_at = now()
    where public.free_demos.status = 'pending'
      and public.free_demos.claimed_at < now() - interval '5 minutes'
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

-- Marks the caller's pending demo as used, or releases it after a failed
-- generation. Requires the server secret (Vault 'demo_server_secret', Vercel
-- env DEMO_SERVER_SECRET) so users can't release their own claim and loop
-- free generations.
create function public.finish_free_demo(p_secret text, p_success boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_secret is null or p_secret is distinct from (
    select decrypted_secret from vault.decrypted_secrets
    where name = 'demo_server_secret' limit 1
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_success then
    update public.free_demos set status = 'used', used_at = now()
    where user_id = auth.uid() and status = 'pending';
  else
    delete from public.free_demos
    where user_id = auth.uid() and status = 'pending';
  end if;
end;
$$;

revoke execute on function public.claim_free_demo() from public, anon;
revoke execute on function public.finish_free_demo(text, boolean) from public, anon;
grant execute on function public.claim_free_demo() to authenticated;
grant execute on function public.finish_free_demo(text, boolean) to authenticated;
