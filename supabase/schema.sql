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

-- Guide comments and replies (also available alone as supabase/comments.sql).
create table if not exists public.guide_comments (
  id         bigint generated always as identity primary key,
  guide_id   bigint not null references public.guides(id) on delete cascade,
  parent_id  bigint references public.guide_comments(id) on delete cascade, -- null = top-level comment
  author_id  uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists guide_comments_guide_idx on public.guide_comments (guide_id, created_at);

grant select, insert, delete on public.guide_comments to authenticated;
grant usage, select on all sequences in schema public to authenticated;
alter table public.guide_comments enable row level security;

drop policy if exists "members read comments" on public.guide_comments;
create policy "members read comments" on public.guide_comments
  for select to authenticated using (true);

-- You can only post as yourself, and replies must stay inside the same guide.
drop policy if exists "members write comments" on public.guide_comments;
create policy "members write comments" on public.guide_comments
  for insert to authenticated with check (
    author_id = auth.uid()
    and (parent_id is null or exists (
      select 1 from public.guide_comments p
      where p.id = parent_id and p.guide_id = guide_comments.guide_id and p.parent_id is null))
  );

drop policy if exists "delete comments" on public.guide_comments;
create policy "delete comments" on public.guide_comments
  for delete to authenticated using (author_id = auth.uid() or public.is_owner());

do $$ begin
  alter publication supabase_realtime add table public.guide_comments;
exception when duplicate_object then null; end $$;

-- Owner member management. Safe to run more than once; changes no data.
-- Every function checks is_owner() itself, and none can touch an owner account.

create or replace function public.list_members()
returns table (id uuid, username text, is_owner boolean, created_at timestamptz, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_owner() then raise exception 'Only the owner can list members'; end if;
  return query
    select p.id, p.username, p.is_owner, p.created_at, u.last_sign_in_at
      from public.profiles p left join auth.users u on u.id = p.id
     order by p.is_owner desc, p.created_at;
end $$;

-- Removes the member's login and, through cascades, their profile, messages and comments.
create or replace function public.remove_member(p_id uuid)
returns void language plpgsql volatile security definer set search_path = public, auth as $$
declare v_target public.profiles;
begin
  if not public.is_owner() then raise exception 'Only the owner can remove members'; end if;
  select * into v_target from public.profiles where id = p_id;
  if not found then raise exception 'No such member'; end if;
  if v_target.is_owner or p_id = auth.uid() then raise exception 'The owner account cannot be removed'; end if;
  delete from auth.users where id = p_id;
end $$;

-- Sets a new password for a member and signs them out everywhere.
create or replace function public.set_member_password(p_id uuid, p_password text)
returns void language plpgsql volatile security definer set search_path = public, auth, extensions as $$
declare v_target public.profiles;
begin
  if not public.is_owner() then raise exception 'Only the owner can reset passwords'; end if;
  if char_length(coalesce(p_password, '')) < 8 then raise exception 'The password must have at least 8 characters'; end if;
  select * into v_target from public.profiles where id = p_id;
  if not found then raise exception 'No such member'; end if;
  if v_target.is_owner then raise exception 'The owner password cannot be reset here'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
   where id = p_id;
  delete from auth.sessions where user_id = p_id;
end $$;

revoke execute on function public.list_members(), public.remove_member(uuid), public.set_member_password(uuid, text) from public, anon;
grant execute on function public.list_members(), public.remove_member(uuid), public.set_member_password(uuid, text) to authenticated;

-- Roles: owner (is_owner) > writer (is_writer) > user. Safe to run more than once.
-- Existing accounts keep working: nobody is a writer until the owner says so.

alter table public.profiles add column if not exists is_writer boolean not null default false;
alter table public.invite_codes add column if not exists role text not null default 'user';
do $$ begin
  alter table public.invite_codes add constraint invite_codes_role_check check (role in ('writer', 'user'));
exception when duplicate_object then null; end $$;

-- Who wrote each guide/video. Rows that already exist stay with no author, so only the owner edits them.
alter table public.guides add column if not exists author_id uuid references public.profiles(id) on delete set null default auth.uid();
alter table public.videos add column if not exists author_id uuid references public.profiles(id) on delete set null default auth.uid();

create or replace function public.can_write()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_owner or is_writer from public.profiles where id = auth.uid()), false);
$$;

-- A new member gets the role the activation code was made for.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_code text := upper(trim(coalesce(new.raw_user_meta_data->>'invite_code', '')));
  v_name text := trim(coalesce(new.raw_user_meta_data->>'username', ''));
  v_role text;
begin
  update public.invite_codes
     set used_by = new.id, used_at = now()
   where code = v_code and used_by is null
  returning role into v_role;
  if not found then
    raise exception 'Invalid or already used activation code';
  end if;

  insert into public.profiles (id, username, is_owner, is_writer)
  values (new.id, v_name,
          not exists (select 1 from public.profiles where is_owner),
          v_role = 'writer');
  return new;
end $$;

-- Owner makes a code for a chosen role.
drop function if exists public.create_invite_code();
create or replace function public.create_invite_code(p_role text default 'user')
returns text language plpgsql volatile security definer set search_path = public as $$
declare
  v_code text;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i int;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can create codes';
  end if;
  if p_role not in ('writer', 'user') then
    raise exception 'Role must be writer or user';
  end if;
  v_code := 'GUILD-';
  for i in 1..8 loop
    v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  insert into public.invite_codes (code, role) values (v_code, p_role);
  return v_code;
end $$;
revoke execute on function public.create_invite_code(text) from public, anon;
grant execute on function public.create_invite_code(text) to authenticated;

-- Owner changes an existing member's role.
create or replace function public.set_member_role(p_id uuid, p_role text)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_target public.profiles;
begin
  if not public.is_owner() then raise exception 'Only the owner can change roles'; end if;
  if p_role not in ('writer', 'user') then raise exception 'Role must be writer or user'; end if;
  select * into v_target from public.profiles where id = p_id;
  if not found then raise exception 'No such member'; end if;
  if v_target.is_owner then raise exception 'The owner role cannot be changed'; end if;
  update public.profiles set is_writer = (p_role = 'writer') where id = p_id;
end $$;
revoke execute on function public.set_member_role(uuid, text) from public, anon;
grant execute on function public.set_member_role(uuid, text) to authenticated;

-- Member list now shows the role.
drop function if exists public.list_members();
create or replace function public.list_members()
returns table (id uuid, username text, is_owner boolean, is_writer boolean, created_at timestamptz, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_owner() then raise exception 'Only the owner can list members'; end if;
  return query
    select p.id, p.username, p.is_owner, p.is_writer, p.created_at, u.last_sign_in_at
      from public.profiles p left join auth.users u on u.id = p.id
     order by p.is_owner desc, p.is_writer desc, p.created_at;
end $$;
revoke execute on function public.list_members() from public, anon;
grant execute on function public.list_members() to authenticated;

-- Guides: owner and writers post; a writer edits or removes only their own; the owner any.
drop policy if exists "owner writes guides" on public.guides;
drop policy if exists "writers add guides" on public.guides;
create policy "writers add guides" on public.guides
  for insert to authenticated with check (public.can_write() and author_id = auth.uid());
drop policy if exists "edit own guides" on public.guides;
create policy "edit own guides" on public.guides
  for update to authenticated
  using (public.is_owner() or (public.can_write() and author_id = auth.uid()))
  with check (public.is_owner() or (public.can_write() and author_id = auth.uid()));
drop policy if exists "delete own guides" on public.guides;
create policy "delete own guides" on public.guides
  for delete to authenticated using (public.is_owner() or (public.can_write() and author_id = auth.uid()));

-- Videos: same rules.
drop policy if exists "owner writes videos" on public.videos;
drop policy if exists "writers add videos" on public.videos;
create policy "writers add videos" on public.videos
  for insert to authenticated with check (public.can_write() and author_id = auth.uid());
drop policy if exists "edit own videos" on public.videos;
create policy "edit own videos" on public.videos
  for update to authenticated
  using (public.is_owner() or (public.can_write() and author_id = auth.uid()))
  with check (public.is_owner() or (public.can_write() and author_id = auth.uid()));
drop policy if exists "delete own videos" on public.videos;
create policy "delete own videos" on public.videos
  for delete to authenticated using (public.is_owner() or (public.can_write() and author_id = auth.uid()));
