-- SkyRunZim race-control database (Supabase project skyrun-2026).
-- Paste the whole file into Supabase > SQL Editor > New query > Run.
-- Safe to run again: it only creates what is missing and replaces the functions.
--
-- How it fits together
--   * Runners never log in. The app calls register_runner() / forget_runner()
--     with the public (publishable) key. Those functions are the ONLY way in:
--     runners cannot read the table, so nobody can see anyone else's details.
--   * Organisers log in on /dashboard/ with an email and password made in
--     Authentication > Users. They can read the table only if their email is
--     in the organisers list below.
--   * Nothing about a runner's position is ever stored; only readiness.

-- ---------------------------------------------------------------- tables
create table if not exists public.registrations (
  device_id   uuid primary key,              -- random id made by the phone
  name        text not null,
  bib         text,
  race_id     text,
  setup_done  boolean not null default false,
  map_saved   boolean not null default false,
  location_ok boolean not null default false,
  app_version text,
  phone       text,                           -- iPhone / Android / Other
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

create table if not exists public.organisers (
  email text primary key                      -- stored lower case
);

alter table public.registrations enable row level security;
alter table public.organisers    enable row level security;

-- Who may see the dashboard. Add more with:
--   insert into public.organisers values ('someone@example.com');
insert into public.organisers (email) values
  ('wildnyanga@farandwide.co.zw'),
  ('thomaseager18@gmail.com')
on conflict do nothing;

-- ---------------------------------------------------------------- organiser check
create or replace function public.is_organiser()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.organisers
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

drop policy if exists "organisers read registrations" on public.registrations;
create policy "organisers read registrations" on public.registrations
  for select to authenticated using (public.is_organiser());

-- Organisers can tidy up test or duplicate entries from the dashboard.
drop policy if exists "organisers delete registrations" on public.registrations;
create policy "organisers delete registrations" on public.registrations
  for delete to authenticated using (public.is_organiser());

-- When the runner accepted the indemnity form in the app, and which wording.
alter table public.registrations add column if not exists indemnity_at timestamptz;
alter table public.registrations add column if not exists indemnity_version text;

-- ---------------------------------------------------------------- runner functions
-- (v19 added the two indemnity arguments; phones still on v18 leave them out.)
drop function if exists public.register_runner(uuid, text, text, text, boolean, boolean, boolean, text, text);
create or replace function public.register_runner(
  p_device uuid, p_name text, p_bib text, p_race text,
  p_setup boolean, p_map boolean, p_location boolean,
  p_app text, p_phone text,
  p_indemnity_at timestamptz default null, p_indemnity_ver text default null
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_device is null or coalesce(btrim(p_name), '') = '' then
    raise exception 'device and name are required';
  end if;
  insert into public.registrations as r
    (device_id, name, bib, race_id, setup_done, map_saved, location_ok, app_version, phone, indemnity_at, indemnity_version)
  values (
    p_device, left(btrim(p_name), 80), nullif(left(btrim(coalesce(p_bib, '')), 12), ''),
    left(p_race, 40), coalesce(p_setup, false), coalesce(p_map, false), coalesce(p_location, false),
    left(p_app, 40), left(p_phone, 20), least(p_indemnity_at, now()), left(p_indemnity_ver, 20))
  on conflict (device_id) do update set
    name = excluded.name, bib = excluded.bib, race_id = excluded.race_id,
    setup_done = excluded.setup_done, map_saved = excluded.map_saved,
    location_ok = excluded.location_ok, app_version = excluded.app_version,
    phone = excluded.phone, last_seen = now(),
    indemnity_at = coalesce(excluded.indemnity_at, r.indemnity_at),
    indemnity_version = coalesce(excluded.indemnity_version, r.indemnity_version);
end;
$$;

-- A runner who untick "share with organisers" is removed completely.
create or replace function public.forget_runner(p_device uuid)
returns void
language sql security definer set search_path = public
as $$ delete from public.registrations where device_id = p_device; $$;

revoke all on function public.register_runner(uuid, text, text, text, boolean, boolean, boolean, text, text, timestamptz, text) from public;
revoke all on function public.forget_runner(uuid) from public;
grant execute on function public.register_runner(uuid, text, text, text, boolean, boolean, boolean, text, text, timestamptz, text) to anon, authenticated;
grant execute on function public.forget_runner(uuid) to anon, authenticated;

-- ---------------------------------------------------------------- live updates
-- The dashboard updates by itself when a runner's phone checks in.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'registrations') then
    alter publication supabase_realtime add table public.registrations;
  end if;
end $$;

-- ================================================================ messages to runners
-- Organisers post from the dashboard; phones collect them whenever they have
-- signal (get_messages) and say when the runner has read them (mark_read).
create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  race_id    text,                             -- null = all runners
  body       text not null check (char_length(body) between 1 and 600),
  author     text default (auth.jwt() ->> 'email')
);
create table if not exists public.message_reads (
  message_id bigint not null references public.messages(id) on delete cascade,
  device_id  uuid not null,
  read_at    timestamptz not null default now(),
  primary key (message_id, device_id)
);
alter table public.messages      enable row level security;
alter table public.message_reads enable row level security;

drop policy if exists "organisers read messages" on public.messages;
create policy "organisers read messages" on public.messages
  for select to authenticated using (public.is_organiser());
drop policy if exists "organisers post messages" on public.messages;
create policy "organisers post messages" on public.messages
  for insert to authenticated with check (public.is_organiser());
drop policy if exists "organisers delete messages" on public.messages;
create policy "organisers delete messages" on public.messages
  for delete to authenticated using (public.is_organiser());
drop policy if exists "organisers read message reads" on public.message_reads;
create policy "organisers read message reads" on public.message_reads
  for select to authenticated using (public.is_organiser());

-- The messages for one runner's race (and those for everyone), newest first.
create or replace function public.get_messages(p_race text)
returns table (id bigint, created_at timestamptz, race_id text, body text)
language sql stable security definer set search_path = public
as $$
  select m.id, m.created_at, m.race_id, m.body from public.messages m
  where m.race_id is null or m.race_id = p_race
  order by m.created_at desc limit 30;
$$;

create or replace function public.mark_read(p_device uuid, p_ids bigint[])
returns void
language sql security definer set search_path = public
as $$
  insert into public.message_reads (message_id, device_id)
  select m.id, p_device from public.messages m where m.id = any(p_ids)
  on conflict do nothing;
$$;

revoke all on function public.get_messages(text) from public;
revoke all on function public.mark_read(uuid, bigint[]) from public;
grant execute on function public.get_messages(text) to anon, authenticated;
grant execute on function public.mark_read(uuid, bigint[]) to anon, authenticated;

-- ================================================================ phone notifications
-- A phone that allows notifications saves its push address here. The
-- send-push Edge Function (supabase/functions/send-push) reads it with the
-- service key when an organiser sends a message. Organisers can only see
-- WHICH runners have notifications on, not the push addresses.
create table if not exists public.push_subscriptions (
  device_id  uuid primary key,
  endpoint   text not null,
  p256dh     text,
  auth       text,
  race_id    text,
  updated_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant select (device_id, race_id, updated_at) on public.push_subscriptions to authenticated;
drop policy if exists "organisers see who has notifications" on public.push_subscriptions;
create policy "organisers see who has notifications" on public.push_subscriptions
  for select to authenticated using (public.is_organiser());

create or replace function public.save_push(p_device uuid, p_endpoint text, p_p256dh text, p_auth text, p_race text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_device is null or p_endpoint !~ '^https://' then raise exception 'bad push address'; end if;
  insert into public.push_subscriptions (device_id, endpoint, p256dh, auth, race_id)
  values (p_device, left(p_endpoint, 1000), left(p_p256dh, 200), left(p_auth, 100), left(p_race, 40))
  on conflict (device_id) do update set endpoint = excluded.endpoint, p256dh = excluded.p256dh,
    auth = excluded.auth, race_id = excluded.race_id, updated_at = now();
end;
$$;
create or replace function public.delete_push(p_device uuid)
returns void
language sql security definer set search_path = public
as $$ delete from public.push_subscriptions where device_id = p_device; $$;

revoke all on function public.save_push(uuid, text, text, text, text) from public;
revoke all on function public.delete_push(uuid) from public;
grant execute on function public.save_push(uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.delete_push(uuid) to anon, authenticated;

-- ================================================================ route updates
-- Organisers publish a corrected route from the dashboard's Race settings tab
-- (GPX dropped in, built in the browser by dashboard/route-build.mjs). Every
-- version is kept, so a mistake can be undone by publishing an older one again.
-- Phones check get_route_updates whenever they have signal and download any
-- newer route with get_route; routes that ship with the app are version 1, 2...
create table if not exists public.race_routes (
  id           bigint generated always as identity primary key,
  race_id      text not null,
  version      int  not null,
  route        jsonb not null,                 -- what the app draws: stages, points, checkpoints
  summary      jsonb not null,                 -- its line in the race list: distance, climb...
  gpx          text,                           -- the file it was built from, kept for reference
  file_name    text,
  note         text,
  published_at timestamptz not null default now(),
  author       text default (auth.jwt() ->> 'email'),
  unique (race_id, version)
);
alter table public.race_routes enable row level security;
drop policy if exists "organisers read routes" on public.race_routes;
create policy "organisers read routes" on public.race_routes
  for select to authenticated using (public.is_organiser());
drop policy if exists "organisers publish routes" on public.race_routes;
create policy "organisers publish routes" on public.race_routes
  for insert to authenticated with check (public.is_organiser());

-- The newest published version of each race (small: no route points).
create or replace function public.get_route_updates()
returns table (race_id text, version int, summary jsonb)
language sql stable security definer set search_path = public
as $$
  select distinct on (r.race_id) r.race_id, r.version, r.summary
  from public.race_routes r order by r.race_id, r.version desc;
$$;
-- The newest route for one race.
create or replace function public.get_route(p_race text)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select r.route from public.race_routes r where r.race_id = p_race order by r.version desc limit 1;
$$;
revoke all on function public.get_route_updates() from public;
revoke all on function public.get_route(text) from public;
grant execute on function public.get_route_updates() to anon, authenticated;
grant execute on function public.get_route(text) to anon, authenticated;

-- ================================================================ start list
-- The organisers' race sheet (the Excel with one tab per race), dropped on the
-- dashboard's Start list tab. Each upload replaces the whole list. Only
-- organisers can see it: runners' phones never download other runners' names.
create table if not exists public.start_list (
  bib         text,
  first_name  text,
  last_name   text,
  race_id     text not null,
  gender      text,
  nationality text,
  category    text
);
create table if not exists public.start_list_uploads (
  id          bigint generated always as identity primary key,
  uploaded_at timestamptz not null default now(),
  author      text default (auth.jwt() ->> 'email'),
  file_name   text,
  runners     int
);
alter table public.start_list         enable row level security;
alter table public.start_list_uploads enable row level security;
drop policy if exists "organisers read start list" on public.start_list;
create policy "organisers read start list" on public.start_list
  for select to authenticated using (public.is_organiser());
drop policy if exists "organisers read start list uploads" on public.start_list_uploads;
create policy "organisers read start list uploads" on public.start_list_uploads
  for select to authenticated using (public.is_organiser());

-- Replace the whole list in one go (all or nothing).
create or replace function public.replace_start_list(p_file text, p_rows jsonb)
returns int
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  if not public.is_organiser() then raise exception 'only organisers can change the start list'; end if;
  delete from public.start_list where true;
  insert into public.start_list (bib, first_name, last_name, race_id, gender, nationality, category)
  select left(x.bib, 12), left(x.first_name, 80), left(x.last_name, 80), left(x.race_id, 40),
         left(x.gender, 20), left(x.nationality, 10), left(x.category, 40)
  from jsonb_to_recordset(p_rows) as x(bib text, first_name text, last_name text, race_id text, gender text, nationality text, category text)
  where x.race_id is not null;
  get diagnostics n = row_count;
  insert into public.start_list_uploads (file_name, runners) values (left(p_file, 200), n);
  return n;
end;
$$;
revoke all on function public.replace_start_list(text, jsonb) from public;
grant execute on function public.replace_start_list(text, jsonb) to authenticated;
