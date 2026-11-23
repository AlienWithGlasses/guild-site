-- Guide comments and replies. Safe to run more than once; changes nothing that already exists.
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
      where p.id = guide_comments.parent_id and p.guide_id = guide_comments.guide_id and p.parent_id is null))
  );

drop policy if exists "delete comments" on public.guide_comments;
create policy "delete comments" on public.guide_comments
  for delete to authenticated using (author_id = auth.uid() or public.is_owner());

do $$ begin
  alter publication supabase_realtime add table public.guide_comments;
exception when duplicate_object then null; end $$;
