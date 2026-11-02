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

-- ---------------------------------------------------------------- runner functions
create or replace function public.register_runner(
  p_device uuid, p_name text, p_bib text, p_race text,
  p_setup boolean, p_map boolean, p_location boolean,
  p_app text, p_phone text
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_device is null or coalesce(btrim(p_name), '') = '' then
    raise exception 'device and name are required';
  end if;
  insert into public.registrations as r
    (device_id, name, bib, race_id, setup_done, map_saved, location_ok, app_version, phone)
  values (
    p_device, left(btrim(p_name), 80), nullif(left(btrim(coalesce(p_bib, '')), 12), ''),
    left(p_race, 40), coalesce(p_setup, false), coalesce(p_map, false), coalesce(p_location, false),
    left(p_app, 40), left(p_phone, 20))
  on conflict (device_id) do update set
    name = excluded.name, bib = excluded.bib, race_id = excluded.race_id,
    setup_done = excluded.setup_done, map_saved = excluded.map_saved,
    location_ok = excluded.location_ok, app_version = excluded.app_version,
    phone = excluded.phone, last_seen = now();
end;
$$;

-- A runner who untick "share with organisers" is removed completely.
create or replace function public.forget_runner(p_device uuid)
returns void
language sql security definer set search_path = public
as $$ delete from public.registrations where device_id = p_device; $$;

revoke all on function public.register_runner(uuid, text, text, text, boolean, boolean, boolean, text, text) from public;
revoke all on function public.forget_runner(uuid) from public;
grant execute on function public.register_runner(uuid, text, text, text, boolean, boolean, boolean, text, text) to anon, authenticated;
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
