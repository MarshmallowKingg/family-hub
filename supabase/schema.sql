-- Family Hub schema. Paste ALL of this into Supabase SQL Editor > New query > Run. Safe to re-run.

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  list text not null check (list in ('shopping','todo')),
  text text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists chores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  emoji text not null default '⭐',
  days int[] not null default '{0,1,2,3,4,5,6}',
  sort int not null default 0,
  active boolean not null default true
);

create table if not exists chore_log (
  id uuid primary key default gen_random_uuid(),
  chore_id uuid not null references chores(id) on delete cascade,
  date date not null,
  done_at timestamptz not null default now(),
  unique (chore_id, date)
);

create table if not exists presence (
  id int primary key default 1,
  seen_at timestamptz not null default now()
);

alter table items     enable row level security;
alter table chores    enable row level security;
alter table chore_log enable row level security;
alter table presence  enable row level security;

drop policy if exists "family" on items;
drop policy if exists "family" on chores;
drop policy if exists "family" on chore_log;
drop policy if exists "family" on presence;
create policy "family" on items     for all to authenticated using (true) with check (true);
create policy "family" on chores    for all to authenticated using (true) with check (true);
create policy "family" on chore_log for all to authenticated using (true) with check (true);
create policy "family" on presence  for all to authenticated using (true) with check (true);

do $$
declare t text;
begin
  foreach t in array array['items','chores','chore_log','presence'] loop
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename=t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

insert into chores (name, emoji, days, sort)
select * from (values
  ('Brush teeth','🪥','{0,1,2,3,4,5,6}'::int[],1),
  ('Tidy toys','🧸','{0,1,2,3,4,5,6}'::int[],2),
  ('Feed Stitch','🐶','{1,3,5}'::int[],3),
  ('Feed Hugo','🐱','{0,2,4,6}'::int[],4)
) v where not exists (select 1 from chores);
