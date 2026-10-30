-- Phase 4: background screenshot reading. The page uploads a bet-slip image to the private 'slips' bucket,
-- inserts a slip_jobs row (RLS: own rows only, always 'queued', no result) and calls the read-slip Edge Function.
-- The function (service role) sets status/result/error, then deletes the image. Any page can show the result later.
-- Idempotent: safe to run more than once.
create table if not exists public.slip_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default '',
  path text not null default '',
  status text not null default 'queued' check (status in ('queued','reading','done','error')),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists slip_jobs_user_created on public.slip_jobs (user_id, created_at desc);

-- keep updated_at fresh
create or replace function public.slip_jobs_touch() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists slip_jobs_touch on public.slip_jobs;
create trigger slip_jobs_touch before update on public.slip_jobs
  for each row execute function public.slip_jobs_touch();

alter table public.slip_jobs enable row level security;
drop policy if exists read_own_slip_jobs on public.slip_jobs;
create policy read_own_slip_jobs on public.slip_jobs for select to authenticated
  using (user_id = auth.uid());
drop policy if exists add_own_slip_jobs on public.slip_jobs;
create policy add_own_slip_jobs on public.slip_jobs for insert to authenticated
  with check (user_id = auth.uid() and status = 'queued' and result is null);
drop policy if exists delete_own_slip_jobs on public.slip_jobs;
create policy delete_own_slip_jobs on public.slip_jobs for delete to authenticated
  using (user_id = auth.uid());
-- no update policy: only the service role (the Edge Function) changes status/result/error.

-- Private Storage bucket for the screenshots (12 MB, images only). Objects are named '<user_id>/<job_id>.jpg'.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('slips', 'slips', false, 12582912, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists slips_insert_own on storage.objects;
create policy slips_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'slips' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists slips_select_own on storage.objects;
create policy slips_select_own on storage.objects for select to authenticated
  using (bucket_id = 'slips' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists slips_delete_own on storage.objects;
create policy slips_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'slips' and (storage.foldername(name))[1] = auth.uid()::text);

-- Cleanup (manual, no pg_cron needed): jobs older than 3 days can be removed any time with
--   delete from public.slip_jobs where created_at < now() - interval '3 days';
