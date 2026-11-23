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
