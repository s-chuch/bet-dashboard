-- Phase 2: per-user page snapshots. The Action builds data/stats/log/archive JSON for each user with the
-- existing Python (scripts/build.py, statsgen.py) and stores them here; the pages read their own row.
-- Same output as today's public files, but private per user.
create table snapshots (
  user_id uuid not null references auth.users on delete cascade,
  kind text not null check (kind in ('data','stats','log','archive')),
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);
alter table snapshots enable row level security;
create policy own_snapshots on snapshots for select to authenticated using (user_id = auth.uid());
-- no insert/update/delete policy: only the service role (Actions) writes.
