-- Phase 3: writes without a GitHub token. The page inserts a request row (RLS: own rows only, always 'pending');
-- the Action (service key) applies it with the same Python the CSV workflows used (add_bets, manual_settle,
-- set_balance), writes the result back into bets/ledger/recommendations, and marks the request done/failed.
create table requests (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind text not null check (kind in ('add_bets','manual_settle','set_balance')),
  payload jsonb not null check (octet_length(payload::text) < 60000),
  status text not null default 'pending' check (status in ('pending','running','done','failed')),
  message text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index requests_pending on requests (status, created_at) where status in ('pending','running');
alter table requests enable row level security;
create policy read_own_requests on requests for select to authenticated using (user_id = auth.uid());
create policy add_own_requests on requests for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending' and message is null and finished_at is null);
-- no update/delete policy: only the service role changes status.
-- Cutover switch: profiles.rules->>'cutover' = 'true' makes the pages read snapshots and send requests.
