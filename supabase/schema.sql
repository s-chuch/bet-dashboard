-- Phase 1 schema for the multi-user bet-dashboard (Supabase / Postgres).
-- Run once in the SQL editor of the NEW project "bet-dashboard".
-- Timestamps from the CSVs are kept as ET text so the import is lossless and balances match exactly.

create table profiles (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  display_name text,
  tz text not null default 'America/Toronto',
  stake_pct numeric not null default 0.5,
  ev_threshold numeric not null default 2,
  rules jsonb not null default '{}',
  slip_owner_names text[] not null default '{}'
);

create table books (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  book text not null,
  abbrev text,
  primary key (user_id, book)
);

create table bets (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  bet_id text not null,
  date date not null,
  book text not null,
  event text not null,
  start_et text,
  market text,
  pick text not null,
  price text,
  boosted_price text,
  stake_text text,
  is_bonus boolean not null default false,
  to_win numeric,
  fair_pct numeric,
  ev_pct numeric,
  result text not null default 'open' check (result in ('open','won','lost','push','void','cashout')),
  pnl numeric,
  settled_at text,
  settled_by text,
  archived boolean not null default false,
  primary key (user_id, bet_id)
);
create index bets_open on bets (user_id) where result = 'open';

create table ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  ts_et text not null,
  book text not null,
  bet_id text,
  event_type text not null check (event_type in ('anchor','stake','return','settled','adjust')),
  amount numeric not null default 0,
  note text
);
create index ledger_user on ledger (user_id, book);

create table recommendations (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  rec_id text not null,
  row jsonb not null,            -- the 22 recommendations.csv columns, kept as-is for now
  primary key (user_id, rec_id)
);

create table skips (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  rec_key text not null,
  reason text,
  day date not null default current_date,
  primary key (user_id, rec_key)
);

-- Shared tables: any signed-in user can read, only the service role (Actions) writes.
create table finder_candidates (key text primary key, payload jsonb not null, updated_at timestamptz not null default now());
create table games_live      (game_id text primary key, payload jsonb not null, updated_at timestamptz not null default now());
create table finals          (game_id text primary key, payload jsonb not null, updated_at timestamptz not null default now());

-- Row level security: users only ever touch their own rows.
do $$ declare t text; begin
  foreach t in array array['books','bets','ledger','recommendations','skips'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy own_rows on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
  alter table profiles enable row level security;
  create policy own_profile on profiles for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
  foreach t in array array['finder_candidates','games_live','finals'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy read_shared on %I for select to authenticated using (true)', t);
  end loop;
end $$;

-- Balances = replay of the ledger exactly like scripts/ledger.py balances(): the latest "anchor" sets the
-- balance, every later event (by id = file order) adds its amount, events before a book's first anchor are ignored.
create view balances with (security_invoker = true) as
  select a.user_id, a.book,
         round(a.amount + coalesce(sum(e.amount) filter (where e.id > a.id), 0), 2) as balance_cad,
         max(e.ts_et) as updated_et
  from (select distinct on (user_id, book) * from ledger where event_type = 'anchor' order by user_id, book, id desc) a
  join ledger e on e.user_id = a.user_id and e.book = a.book and e.id >= a.id
  group by a.user_id, a.book, a.amount, a.id;
