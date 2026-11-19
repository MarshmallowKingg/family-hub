-- Family Hub schema. Run once in Supabase: SQL Editor > New query > paste > Run.
-- Access is limited to signed-in users; create ONE family login under Authentication > Users
-- and turn OFF "Allow new users to sign up" (Authentication > Sign In / Providers).

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
  days int[] not null default '{0,1,2,3,4,5,6}',   -- 0 = Sunday
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

-- Phase 3: presence sensor writes here to wake the screen
create table if not exists presence (
  id int primary key default 1,
  seen_at timestamptz not null default now()
);

alter table items     enable row level security;
alter table chores    enable row level security;
alter table chore_log enable row level security;
alter table presence  enable row level security;

create policy "family" on items     for all to authenticated using (true) with check (true);
create policy "family" on chores    for all to authenticated using (true) with check (true);
create policy "family" on chore_log for all to authenticated using (true) with check (true);
create policy "family" on presence  for all to authenticated using (true) with check (true);

-- Live updates to every screen
alter publication supabase_realtime add table items, chores, chore_log, presence;

-- Starter jobs for Rae (edit in the app)
insert into chores (name, emoji, days, sort) values
  ('Brush teeth','🪥','{0,1,2,3,4,5,6}',1),
  ('Tidy toys','🧸','{0,1,2,3,4,5,6}',2),
  ('Feed Stitch','🐶','{1,3,5}',3),
  ('Feed Hugo','🐱','{0,2,4,6}',4);
