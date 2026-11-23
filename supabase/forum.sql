-- Guide categories + Reddit-style threads. Safe to run more than once; changes no existing data.

-- ===== Guide categories (owner creates them; owner and writers file guides in them) =====
create table if not exists public.guide_categories (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(trim(name)) between 1 and 40),
  position   int not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists guide_categories_name_idx on public.guide_categories (lower(trim(name)));
alter table public.guides add column if not exists category_id bigint references public.guide_categories(id) on delete set null;

revoke all on public.guide_categories from anon;
grant select, insert, update, delete on public.guide_categories to authenticated;
alter table public.guide_categories enable row level security;
drop policy if exists "members read categories" on public.guide_categories;
create policy "members read categories" on public.guide_categories for select to authenticated using (true);
drop policy if exists "owner writes categories" on public.guide_categories;
create policy "owner writes categories" on public.guide_categories
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- ===== Threads =====
create table if not exists public.threads (
  id            bigint generated always as identity primary key,
  author_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title         text not null check (char_length(title) between 3 and 200),
  body          text not null default '' check (char_length(body) <= 10000),
  pinned        boolean not null default false,
  score         int not null default 0,
  comment_count int not null default 0,
  created_at    timestamptz not null default now()
);
create table if not exists public.thread_comments (
  id         bigint generated always as identity primary key,
  thread_id  bigint not null references public.threads(id) on delete cascade,
  parent_id  bigint references public.thread_comments(id) on delete cascade,
  author_id  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 4000),
  score      int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists thread_comments_thread_idx on public.thread_comments (thread_id, created_at);
-- one vote per person per thread or comment
create table if not exists public.votes (
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  thread_id  bigint references public.threads(id) on delete cascade,
  comment_id bigint references public.thread_comments(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((thread_id is null) <> (comment_id is null))
);
create unique index if not exists votes_thread_uq on public.votes (user_id, thread_id) where thread_id is not null;
create unique index if not exists votes_comment_uq on public.votes (user_id, comment_id) where comment_id is not null;

-- Scores and comment counts are kept by the database, so nobody can set them by hand.
create or replace function public.apply_vote() returns trigger
language plpgsql security definer set search_path = public as $$
declare d int := case when tg_op = 'INSERT' then 1 else -1 end;
        r public.votes := case when tg_op = 'INSERT' then new else old end;
begin
  if r.thread_id is not null then
    update public.threads set score = score + d where id = r.thread_id;
  else
    update public.thread_comments set score = score + d where id = r.comment_id;
  end if;
  return null;
end $$;
drop trigger if exists on_vote_change on public.votes;
create trigger on_vote_change after insert or delete on public.votes
  for each row execute function public.apply_vote();

create or replace function public.apply_comment_count() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.threads set comment_count = comment_count + 1 where id = new.thread_id;
  else
    update public.threads set comment_count = greatest(comment_count - 1, 0) where id = old.thread_id;
  end if;
  return null;
end $$;
drop trigger if exists on_thread_comment_change on public.thread_comments;
create trigger on_thread_comment_change after insert or delete on public.thread_comments
  for each row execute function public.apply_comment_count();

revoke all on public.threads, public.thread_comments, public.votes from anon;
-- members insert and delete through the policies below; only "pinned" may be updated, and only by the owner
revoke update on public.threads from authenticated;
grant select, insert, delete on public.threads, public.thread_comments, public.votes to authenticated;
grant update (pinned) on public.threads to authenticated;
alter table public.threads         enable row level security;
alter table public.thread_comments enable row level security;
alter table public.votes           enable row level security;

drop policy if exists "members read threads" on public.threads;
create policy "members read threads" on public.threads for select to authenticated using (true);
drop policy if exists "members start threads" on public.threads;
create policy "members start threads" on public.threads
  for insert to authenticated with check (author_id = auth.uid() and pinned = false and score = 0 and comment_count = 0);
drop policy if exists "delete own threads" on public.threads;
create policy "delete own threads" on public.threads
  for delete to authenticated using (author_id = auth.uid() or public.is_owner());
drop policy if exists "owner pins threads" on public.threads;
create policy "owner pins threads" on public.threads
  for update to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists "members read thread comments" on public.thread_comments;
create policy "members read thread comments" on public.thread_comments for select to authenticated using (true);
drop policy if exists "members write thread comments" on public.thread_comments;
create policy "members write thread comments" on public.thread_comments
  for insert to authenticated with check (
    author_id = auth.uid() and score = 0
    and (parent_id is null or exists (
      select 1 from public.thread_comments p where p.id = thread_comments.parent_id and p.thread_id = thread_comments.thread_id))
  );
drop policy if exists "delete own thread comments" on public.thread_comments;
create policy "delete own thread comments" on public.thread_comments
  for delete to authenticated using (author_id = auth.uid() or public.is_owner());

drop policy if exists "read own votes" on public.votes;
create policy "read own votes" on public.votes for select to authenticated using (user_id = auth.uid());
drop policy if exists "cast own votes" on public.votes;
create policy "cast own votes" on public.votes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "withdraw own votes" on public.votes;
create policy "withdraw own votes" on public.votes for delete to authenticated using (user_id = auth.uid());
