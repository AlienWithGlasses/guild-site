-- =====================================================================
-- Guild website database setup (Supabase)
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to read: every table is locked down with Row Level Security.
-- Passwords are NOT stored here. Supabase Auth stores them as bcrypt
-- hashes in its own protected auth schema.
-- =====================================================================

-- ---------- Tables ----------------------------------------------------

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text not null unique
             check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  is_owner   boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.invite_codes (
  code       text primary key,
  created_at timestamptz not null default now(),
  used_by    uuid references auth.users(id) on delete set null,
  used_at    timestamptz
);

create table if not exists public.messages (
  id           bigint generated always as identity primary key,
  author_id    uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid references public.profiles(id) on delete cascade, -- null = public
  body         text not null check (char_length(body) between 1 and 4000),
  created_at   timestamptz not null default now()
);
create index if not exists messages_recipient_idx on public.messages (recipient_id, created_at);

create table if not exists public.guides (
  id         bigint generated always as identity primary key,
  title      text not null check (char_length(title) between 1 and 200),
  body       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.videos (
  id         bigint generated always as identity primary key,
  title      text not null check (char_length(title) between 1 and 200),
  youtube_id text not null check (youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  created_at timestamptz not null default now()
);

-- ---------- Helper: is the current user the owner? --------------------

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_owner from public.profiles where id = auth.uid()), false);
$$;

-- ---------- Sign-up gate: an unused activation code is required -------
-- Runs inside the sign-up itself, so nobody can create an account
-- without a valid code, even by calling the API directly.
-- The very first person to sign up becomes the owner.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_code text := upper(trim(coalesce(new.raw_user_meta_data->>'invite_code', '')));
  v_name text := trim(coalesce(new.raw_user_meta_data->>'username', ''));
begin
  update public.invite_codes
     set used_by = new.id, used_at = now()
   where code = v_code and used_by is null;
  if not found then
    raise exception 'Invalid or already used activation code';
  end if;

  insert into public.profiles (id, username, is_owner)
  values (new.id, v_name,
          not exists (select 1 from public.profiles where is_owner));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Small functions the website calls -------------------------

-- Lets the sign-up page say "code not valid" before trying.
create or replace function public.check_invite_code(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.invite_codes
                 where code = upper(trim(p_code)) and used_by is null);
$$;

create or replace function public.username_available(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where lower(username) = lower(trim(p_name)));
$$;

-- Owner only: make a new random activation code like "GUILD-7K3QX9PA".
create or replace function public.create_invite_code()
returns text language plpgsql volatile security definer set search_path = public as $$
declare
  v_code text;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i int;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can create codes';
  end if;
  v_code := 'GUILD-';
  for i in 1..8 loop
    v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  insert into public.invite_codes (code) values (v_code);
  return v_code;
end $$;

revoke execute on function public.create_invite_code() from public, anon;
grant execute on function public.create_invite_code() to authenticated;

-- Signed-in members can reach the tables; the rules below decide what they actually see.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.check_invite_code(text) to anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------- Row Level Security (who can read/write what) --------------

alter table public.profiles     enable row level security;
alter table public.invite_codes enable row level security;
alter table public.messages     enable row level security;
alter table public.guides       enable row level security;
alter table public.videos       enable row level security;

-- Profiles: signed-in members can see each other's names.
drop policy if exists "members read profiles" on public.profiles;
create policy "members read profiles" on public.profiles
  for select to authenticated using (true);

-- Invite codes: only the owner can see the list (creation goes through the function).
drop policy if exists "owner reads codes" on public.invite_codes;
create policy "owner reads codes" on public.invite_codes
  for select to authenticated using (public.is_owner());
drop policy if exists "owner deletes codes" on public.invite_codes;
create policy "owner deletes codes" on public.invite_codes
  for delete to authenticated using (public.is_owner() and used_by is null);

-- Messages: public ones are visible to all members; private ones only
-- to the two people in the conversation.
drop policy if exists "read messages" on public.messages;
create policy "read messages" on public.messages
  for select to authenticated using (
    recipient_id is null or author_id = auth.uid() or recipient_id = auth.uid()
  );

-- Members may post publicly or privately to the owner. The owner may
-- post publicly or privately to anyone.
drop policy if exists "send messages" on public.messages;
create policy "send messages" on public.messages
  for insert to authenticated with check (
    author_id = auth.uid() and (
      recipient_id is null
      or public.is_owner()
      or recipient_id in (select id from public.profiles where is_owner)
    )
  );

-- Authors can delete their own messages; the owner can delete any.
drop policy if exists "delete messages" on public.messages;
create policy "delete messages" on public.messages
  for delete to authenticated using (author_id = auth.uid() or public.is_owner());

-- Guides and videos: members read, owner writes.
drop policy if exists "members read guides" on public.guides;
create policy "members read guides" on public.guides
  for select to authenticated using (true);
drop policy if exists "owner writes guides" on public.guides;
create policy "owner writes guides" on public.guides
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists "members read videos" on public.videos;
create policy "members read videos" on public.videos
  for select to authenticated using (true);
drop policy if exists "owner writes videos" on public.videos;
create policy "owner writes videos" on public.videos
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- Live updates for chat.
do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null; end $$;

-- ---------- Your first code -------------------------------------------
-- Use this code to create YOUR account first. The first account becomes
-- the owner. Change the text if you like, then run.
insert into public.invite_codes (code) values ('FOUNDER-START')
on conflict do nothing;
