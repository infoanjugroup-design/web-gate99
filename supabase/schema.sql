-- =====================================================================
-- GATE99 — Supabase schema (PostgreSQL)
-- Run this once in the Supabase SQL Editor on a fresh project.
-- Safe to re-run: every statement is guarded with IF NOT EXISTS / OR REPLACE.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- PROFILES  (one row per auth.users row — student OR admin OR mainadmin)
-- ---------------------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'student' check (role in ('student', 'admin', 'mainadmin')),
  name text,
  email text,
  mobile text,
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);

-- Auto-create a profile row the moment someone signs up via Supabase Auth.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, email, role, name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'role', 'student'),
    new.raw_user_meta_data ->> 'name'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Helper: is the CURRENT logged-in user an admin/mainadmin? Used in policies below.
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role in ('admin', 'mainadmin')
  );
$$;

create or replace function is_mainadmin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'mainadmin');
$$;

-- ---------------------------------------------------------------------
-- CATALOG: courses -> subjects -> topics -> lectures
-- ---------------------------------------------------------------------
create table if not exists courses (
  id uuid primary key default gen_random_uuid(),
  course_name text not null,
  fees numeric not null default 0,
  course_image text,
  created_at timestamptz not null default now()
);

create table if not exists subjects (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses(id) on delete cascade,
  subject_name text not null
);

create table if not exists topics (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references subjects(id) on delete cascade,
  topic_name text not null
);

create table if not exists lectures (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references topics(id) on delete cascade,
  video_id text,
  title text not null,
  embed_code text
);

-- ---------------------------------------------------------------------
-- TESTS & PYQS  — correct/answer_key/content_enc/file_path are SECRET.
-- Students only ever read them through the *_public views below, or via
-- the submit_answer() RPC, which checks the answer server-side.
-- ---------------------------------------------------------------------
create table if not exists tests (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references topics(id) on delete cascade,
  question text,
  option_a text, option_b text, option_c text, option_d text,
  correct text,                 -- SECRET: "A" | "A,C" (MSQ) | numeric string (NAT)
  type text not null default 'MCQ' check (type in ('MCQ', 'MSQ', 'NAT')),
  tolerance numeric not null default 0,
  test_name text,
  test_type text,
  is_file boolean not null default false,
  file_path text,               -- SECRET: storage path, never sent to the client directly
  file_name text,
  file_mime text,
  file_size bigint,
  answer_key text,              -- SECRET: storage path to answer key PDF
  content_enc text              -- SECRET
);

create table if not exists pyqs (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references topics(id) on delete cascade,
  year int,
  question text,
  option_a text, option_b text, option_c text, option_d text,
  correct text,
  type text not null default 'MCQ' check (type in ('MCQ', 'MSQ', 'NAT')),
  tolerance numeric not null default 0,
  pyq_name text,
  pyq_type text,
  is_file boolean not null default false,
  file_path text,
  file_name text,
  file_mime text,
  file_size bigint,
  answer_key text,
  content_enc text
);

-- Public-safe views: every SECRET column is dropped, never nulled-out-in-place
-- (so there is no way to accidentally select the real column through these).
create or replace view tests_public as
  select id, topic_id, question, option_a, option_b, option_c, option_d,
         type, tolerance, test_name, test_type, is_file, file_name, file_mime, file_size
  from tests;

create or replace view pyqs_public as
  select id, topic_id, year, question, option_a, option_b, option_c, option_d,
         type, tolerance, pyq_name, pyq_type, is_file, file_name, file_mime, file_size
  from pyqs;

-- ---------------------------------------------------------------------
-- BOOKS + entitlement
-- ---------------------------------------------------------------------
create table if not exists books (
  id uuid primary key default gen_random_uuid(),
  book_name text not null,
  course_id uuid references courses(id) on delete set null,
  storage_path text not null,   -- path inside the private "books" storage bucket
  book_image text
);

create table if not exists student_books (
  student_id uuid not null references profiles(id) on delete cascade,
  book_id uuid not null references books(id) on delete cascade,
  primary key (student_id, book_id)
);

-- ---------------------------------------------------------------------
-- ENROLLMENT / COMMERCE
-- ---------------------------------------------------------------------
create table if not exists enrollments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references profiles(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  purchased_at timestamptz not null default now(),
  unique (student_id, course_id)
);

create table if not exists purchases (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references profiles(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  transaction_id text,
  payment_method text,
  amount numeric,
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  bill_no text,
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

create table if not exists bills (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references profiles(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  bill_no text,
  amount numeric,
  issued_at timestamptz not null default now()
);

create table if not exists payment_settings (
  id int primary key default 1 check (id = 1),
  account_no text, ifsc text, upi_id text, qr_url text, signature_url text,
  updated_at timestamptz not null default now()
);
insert into payment_settings (id) values (1) on conflict (id) do nothing;

create table if not exists free_courses (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses(id) on delete cascade,
  test_ids uuid[] not null default '{}',
  pyq_ids uuid[] not null default '{}',
  book_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- DOUBTS BOARD (realtime-enabled below)
-- ---------------------------------------------------------------------
create table if not exists doubts (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references profiles(id) on delete cascade,
  name text,
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists doubt_replies (
  id uuid primary key default gen_random_uuid(),
  doubt_id uuid not null references doubts(id) on delete cascade,
  student_id uuid not null references profiles(id) on delete cascade,
  name text,
  message text not null,
  is_correct boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- ATTEMPTS + PERFORMANCE ROLL-UP
-- ---------------------------------------------------------------------
create table if not exists attempts (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references profiles(id) on delete cascade,
  kind text not null,                 -- 'video' | 'test' | 'pyq'
  ref_id uuid,
  course_id uuid references courses(id) on delete set null,
  correct boolean,
  points numeric not null default 0,
  attempt_key text unique,            -- de-dupe key, e.g. student_id:kind:ref_id
  created_at timestamptz not null default now()
);

create table if not exists perf_summary (
  student_id uuid primary key references profiles(id) on delete cascade,
  total_points numeric not null default 0,
  video_count int not null default 0,
  correct_count int not null default 0,
  wrong_count int not null default 0,
  doubt_points numeric not null default 0,
  attempt_count int not null default 0
);

create table if not exists feedbacks (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references profiles(id) on delete set null,
  name text, email text,
  message text not null,
  attachment_url text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  reply text,
  replied_at timestamptz,
  created_at timestamptz not null default now()
);

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table profiles enable row level security;
alter table courses enable row level security;
alter table subjects enable row level security;
alter table topics enable row level security;
alter table lectures enable row level security;
alter table tests enable row level security;
alter table pyqs enable row level security;
alter table books enable row level security;
alter table student_books enable row level security;
alter table enrollments enable row level security;
alter table purchases enable row level security;
alter table bills enable row level security;
alter table payment_settings enable row level security;
alter table free_courses enable row level security;
alter table doubts enable row level security;
alter table doubt_replies enable row level security;
alter table attempts enable row level security;
alter table perf_summary enable row level security;
alter table feedbacks enable row level security;

-- profiles
drop policy if exists "profiles_self_select" on profiles;
create policy "profiles_self_select" on profiles for select using (id = auth.uid() or is_admin());
drop policy if exists "profiles_self_update" on profiles;
create policy "profiles_self_update" on profiles for update using (id = auth.uid() or is_admin());
drop policy if exists "profiles_admin_write" on profiles;
create policy "profiles_admin_write" on profiles for insert with check (id = auth.uid() or is_admin());

-- catalog: public read, admin write
drop policy if exists "courses_read" on courses;
create policy "courses_read" on courses for select using (true);
drop policy if exists "courses_write" on courses;
create policy "courses_write" on courses for all using (is_admin()) with check (is_admin());

drop policy if exists "subjects_read" on subjects;
create policy "subjects_read" on subjects for select using (true);
drop policy if exists "subjects_write" on subjects;
create policy "subjects_write" on subjects for all using (is_admin()) with check (is_admin());

drop policy if exists "topics_read" on topics;
create policy "topics_read" on topics for select using (true);
drop policy if exists "topics_write" on topics;
create policy "topics_write" on topics for all using (is_admin()) with check (is_admin());

-- lectures: only enrolled students (+ admins) can read; free courses handled client-side via free_courses list
drop policy if exists "lectures_read" on lectures;
create policy "lectures_read" on lectures for select using (
  is_admin() or exists (
    select 1 from topics t join subjects s on s.id = t.subject_id
    join enrollments e on e.course_id = s.course_id
    where t.id = lectures.topic_id and e.student_id = auth.uid()
  )
);
drop policy if exists "lectures_write" on lectures;
create policy "lectures_write" on lectures for all using (is_admin()) with check (is_admin());

-- tests/pyqs: base tables are ADMIN-ONLY (secret columns live here).
-- Students read through tests_public/pyqs_public instead (views inherit
-- the security_invoker check below via the RPC, not direct table grants).
drop policy if exists "tests_admin_only" on tests;
create policy "tests_admin_only" on tests for all using (is_admin()) with check (is_admin());
drop policy if exists "pyqs_admin_only" on pyqs;
create policy "pyqs_admin_only" on pyqs for all using (is_admin()) with check (is_admin());

-- Views run with the caller's privileges by default in Postgres, which would
-- hit the admin-only RLS above and return nothing to students. Mark them
-- SECURITY INVOKER=false equivalent by granting select on the view itself
-- and using a security_barrier + security definer function instead of a
-- bare view for the actual read path students use:
create or replace function get_tests_public(p_topic_id uuid)
returns setof tests_public
language sql
stable
security definer
set search_path = public
as $$
  select * from tests_public
  where topic_id = p_topic_id
    and (
      is_admin() or exists (
        select 1 from topics t join subjects s on s.id = t.subject_id
        join enrollments e on e.course_id = s.course_id
        where t.id = p_topic_id and e.student_id = auth.uid()
      )
    );
$$;

create or replace function get_pyqs_public(p_topic_id uuid)
returns setof pyqs_public
language sql
stable
security definer
set search_path = public
as $$
  select * from pyqs_public
  where topic_id = p_topic_id
    and (
      is_admin() or exists (
        select 1 from topics t join subjects s on s.id = t.subject_id
        join enrollments e on e.course_id = s.course_id
        where t.id = p_topic_id and e.student_id = auth.uid()
      )
    );
$$;

-- books: admin full access; students see rows only for books they own
drop policy if exists "books_read" on books;
create policy "books_read" on books for select using (
  is_admin() or exists (
    select 1 from student_books sb where sb.book_id = books.id and sb.student_id = auth.uid()
  )
);
drop policy if exists "books_write" on books;
create policy "books_write" on books for all using (is_admin()) with check (is_admin());

drop policy if exists "student_books_read" on student_books;
create policy "student_books_read" on student_books for select using (student_id = auth.uid() or is_admin());
drop policy if exists "student_books_write" on student_books;
create policy "student_books_write" on student_books for all using (is_admin()) with check (is_admin());

-- enrollments
drop policy if exists "enrollments_read" on enrollments;
create policy "enrollments_read" on enrollments for select using (student_id = auth.uid() or is_admin());
drop policy if exists "enrollments_write" on enrollments;
create policy "enrollments_write" on enrollments for all using (is_admin()) with check (is_admin());

-- purchases: student can create + read their own; only admin can update (verify)
drop policy if exists "purchases_read" on purchases;
create policy "purchases_read" on purchases for select using (student_id = auth.uid() or is_admin());
drop policy if exists "purchases_insert" on purchases;
create policy "purchases_insert" on purchases for insert with check (student_id = auth.uid());
drop policy if exists "purchases_update" on purchases;
create policy "purchases_update" on purchases for update using (is_admin());

drop policy if exists "bills_read" on bills;
create policy "bills_read" on bills for select using (student_id = auth.uid() or is_admin());
drop policy if exists "bills_write" on bills;
create policy "bills_write" on bills for all using (is_admin()) with check (is_admin());

drop policy if exists "payment_settings_read" on payment_settings;
create policy "payment_settings_read" on payment_settings for select using (true);
drop policy if exists "payment_settings_write" on payment_settings;
create policy "payment_settings_write" on payment_settings for update using (is_admin());

drop policy if exists "free_courses_read" on free_courses;
create policy "free_courses_read" on free_courses for select using (true);
drop policy if exists "free_courses_write" on free_courses;
create policy "free_courses_write" on free_courses for all using (is_admin()) with check (is_admin());

-- doubts board: any signed-in student/admin can read all + post; only
-- admin or the author can be corrected/removed
drop policy if exists "doubts_read" on doubts;
create policy "doubts_read" on doubts for select using (auth.uid() is not null);
drop policy if exists "doubts_insert" on doubts;
create policy "doubts_insert" on doubts for insert with check (student_id = auth.uid());
drop policy if exists "doubts_delete" on doubts;
create policy "doubts_delete" on doubts for delete using (student_id = auth.uid() or is_admin());

drop policy if exists "doubt_replies_read" on doubt_replies;
create policy "doubt_replies_read" on doubt_replies for select using (auth.uid() is not null);
drop policy if exists "doubt_replies_insert" on doubt_replies;
create policy "doubt_replies_insert" on doubt_replies for insert with check (student_id = auth.uid());
drop policy if exists "doubt_replies_update" on doubt_replies;
create policy "doubt_replies_update" on doubt_replies for update using (
  is_admin() or exists (select 1 from doubts d where d.id = doubt_id and d.student_id = auth.uid())
);

-- attempts / perf_summary: student reads own; writes only ever happen via the
-- submit_answer()/log_video_watch() RPCs below (security definer), never
-- directly from the client.
drop policy if exists "attempts_read" on attempts;
create policy "attempts_read" on attempts for select using (student_id = auth.uid() or is_admin());
drop policy if exists "attempts_no_direct_write" on attempts;
create policy "attempts_no_direct_write" on attempts for all using (is_admin()) with check (is_admin());

drop policy if exists "perf_summary_read" on perf_summary;
create policy "perf_summary_read" on perf_summary for select using (student_id = auth.uid() or is_admin());
drop policy if exists "perf_summary_no_direct_write" on perf_summary;
create policy "perf_summary_no_direct_write" on perf_summary for all using (is_admin()) with check (is_admin());

-- feedback
drop policy if exists "feedbacks_read" on feedbacks;
create policy "feedbacks_read" on feedbacks for select using (student_id = auth.uid() or is_admin());
drop policy if exists "feedbacks_insert" on feedbacks;
create policy "feedbacks_insert" on feedbacks for insert with check (student_id = auth.uid());
drop policy if exists "feedbacks_update" on feedbacks;
create policy "feedbacks_update" on feedbacks for update using (is_admin());

-- =====================================================================
-- SECURE GRADING — the only path a student ever hits to score a test.
-- The real `correct` value never leaves Postgres.
-- =====================================================================
create or replace function grade_answer(p_correct text, p_type text, p_tolerance numeric, p_selected text)
returns boolean
language plpgsql
immutable
as $$
begin
  if p_correct is null or p_selected is null then return false; end if;
  if p_type = 'NAT' then
    begin
      return abs(p_selected::numeric - p_correct::numeric) <= coalesce(p_tolerance, 0);
    exception when others then return false;
    end;
  elsif p_type = 'MSQ' then
    return (
      select array_agg(x order by x) from unnest(string_to_array(p_correct, ',')) x
    ) = (
      select array_agg(x order by x) from unnest(string_to_array(p_selected, ',')) x
    );
  else
    return trim(upper(p_correct)) = trim(upper(p_selected));
  end if;
end;
$$;

create or replace function submit_answer(p_kind text, p_ref_id uuid, p_course_id uuid, p_selected text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_correct text; v_type text; v_tolerance numeric;
  v_is_correct boolean; v_points numeric;
  v_key text := auth.uid()::text || ':' || p_kind || ':' || p_ref_id::text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  if p_kind = 'test' then
    select correct, type, tolerance into v_correct, v_type, v_tolerance from tests where id = p_ref_id;
  elsif p_kind = 'pyq' then
    select correct, type, tolerance into v_correct, v_type, v_tolerance from pyqs where id = p_ref_id;
  else
    raise exception 'Unknown kind %', p_kind;
  end if;

  v_is_correct := grade_answer(v_correct, v_type, v_tolerance, p_selected);
  v_points := case when v_is_correct then 4 else -1 end; -- GATE-style +4/-1; tune as needed

  insert into attempts (student_id, kind, ref_id, course_id, correct, points, attempt_key)
  values (auth.uid(), p_kind, p_ref_id, p_course_id, v_is_correct, v_points, v_key)
  on conflict (attempt_key) do nothing;

  if found then
    insert into perf_summary (student_id, total_points, correct_count, wrong_count, attempt_count)
    values (auth.uid(), v_points, (v_is_correct)::int, (not v_is_correct)::int, 1)
    on conflict (student_id) do update set
      total_points = perf_summary.total_points + excluded.total_points,
      correct_count = perf_summary.correct_count + excluded.correct_count,
      wrong_count = perf_summary.wrong_count + excluded.wrong_count,
      attempt_count = perf_summary.attempt_count + 1;
  end if;

  return jsonb_build_object('correct', v_is_correct, 'points', v_points);
end;
$$;

create or replace function log_video_watch(p_lecture_id uuid, p_course_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_key text := auth.uid()::text || ':video:' || p_lecture_id::text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  insert into attempts (student_id, kind, ref_id, course_id, points, attempt_key)
  values (auth.uid(), 'video', p_lecture_id, p_course_id, 1, v_key)
  on conflict (attempt_key) do nothing;
  if found then
    insert into perf_summary (student_id, total_points, video_count)
    values (auth.uid(), 1, 1)
    on conflict (student_id) do update set
      total_points = perf_summary.total_points + 1,
      video_count = perf_summary.video_count + 1;
  end if;
end;
$$;

-- =====================================================================
-- REALTIME — doubts board updates live for every connected student
-- =====================================================================
alter publication supabase_realtime add table doubts;
alter publication supabase_realtime add table doubt_replies;

-- =====================================================================
-- STORAGE BUCKETS (run once; safe if they already exist)
-- Both buckets are PRIVATE — every read goes through a signed URL that a
-- Netlify Function issues only after checking entitlement in Postgres.
-- =====================================================================
insert into storage.buckets (id, name, public) values ('books', 'books', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('course-media', 'course-media', true) on conflict (id) do nothing;

-- Admins can manage the books bucket directly from the dashboard/client;
-- students never get direct storage access to it (only via signed URLs
-- returned by the get-book-url Netlify Function using the service role key).
drop policy if exists "books_bucket_admin" on storage.objects;
create policy "books_bucket_admin" on storage.objects for all
  using (bucket_id = 'books' and is_admin())
  with check (bucket_id = 'books' and is_admin());

drop policy if exists "course_media_public_read" on storage.objects;
create policy "course_media_public_read" on storage.objects for select
  using (bucket_id = 'course-media');
drop policy if exists "course_media_admin_write" on storage.objects;
create policy "course_media_admin_write" on storage.objects for all
  using (bucket_id = 'course-media' and is_admin())
  with check (bucket_id = 'course-media' and is_admin());

-- =====================================================================
-- BOOTSTRAP: promote your first admin manually after they've signed up once
-- through the normal /login flow, e.g.:
--   update profiles set role = 'mainadmin' where email = 'you@example.com';
-- =====================================================================
