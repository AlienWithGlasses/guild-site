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
