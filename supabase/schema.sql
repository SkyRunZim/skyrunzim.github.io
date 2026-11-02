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
