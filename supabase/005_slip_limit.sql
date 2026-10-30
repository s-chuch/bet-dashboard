-- Daily cap on server-side screenshot reads, so a stray sign-up cannot run up the Gemini quota.
-- slip_use() counts one read for a user today (UTC) and returns false once the limit is reached. Only the service role
-- (the read-slip Edge Function) may call it. The limit itself comes from the function's READ_SLIP_DAILY_LIMIT secret (default 60).
-- Idempotent: safe to run more than once.
create table if not exists public.slip_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  n integer not null default 0,
  primary key (user_id, day)
);
alter table public.slip_usage enable row level security;   -- no policies: users cannot read or write it; the service role bypasses RLS

create or replace function public.slip_use(p_user uuid, p_limit integer) returns boolean
language plpgsql security definer set search_path = public as $$
declare used integer;
begin
  if p_limit <= 0 then return false; end if;   -- 0 switches reading off
  insert into public.slip_usage (user_id, day, n) values (p_user, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set n = public.slip_usage.n + 1 where public.slip_usage.n < p_limit
  returning n into used;
  return used is not null;   -- null: the row was at the limit, so nothing was updated
end $$;
revoke all on function public.slip_use(uuid, integer) from public, anon, authenticated;
grant execute on function public.slip_use(uuid, integer) to service_role;
-- Housekeeping (manual): delete from public.slip_usage where day < current_date - 30;
