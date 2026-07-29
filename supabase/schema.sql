
-- =====================================================================
-- GATE99 — MIGRATION: switch entity IDs from uuid -> short alphanumeric text
-- Run this ONCE in the Supabase SQL Editor, AFTER your original schema.sql.
-- Safe on existing data: every uuid value is simply re-cast to its text
-- string form (e.g. "a1b2c3d4-..." stays exactly that string) — nothing is
-- deleted or regenerated for rows that already exist.
--
-- NOT changed: profiles.id / auth.users.id — these MUST stay uuid because
-- Supabase Auth itself assigns and manages them. Instead, students get a
-- new alphanumeric `student_code` column (see PART 3) for a human-friendly,
-- fully alphanumeric "Student ID" you can show/search/print anywhere.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PART 0 — helper: generate a short, collision-safe alphanumeric id
-- e.g. gen_short_id('C') -> 'C7F3K2A9'   gen_short_id('SUB') -> 'SUB4M1XQ2'
-- ---------------------------------------------------------------------
create or replace function gen_short_id(prefix text default '')
returns text
language sql
volatile
as $$
  select prefix || upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 8));
$$;

-- ---------------------------------------------------------------------
-- PART 1 — drop the foreign-key constraints we're about to retype
-- (names match what schema.sql created; drop is a no-op if already gone)
-- ---------------------------------------------------------------------
alter table subjects       drop constraint if exists subjects_course_id_fkey;
alter table topics         drop constraint if exists topics_subject_id_fkey;
alter table lectures       drop constraint if exists lectures_topic_id_fkey;
alter table tests          drop constraint if exists tests_topic_id_fkey;
alter table pyqs           drop constraint if exists pyqs_topic_id_fkey;
alter table books          drop constraint if exists books_course_id_fkey;
alter table student_books  drop constraint if exists student_books_book_id_fkey;
alter table enrollments    drop constraint if exists enrollments_course_id_fkey;
alter table purchases      drop constraint if exists purchases_course_id_fkey;

-- ---------------------------------------------------------------------
-- PART 2 — retype every entity's primary key uuid -> text, and give it
-- the new alphanumeric default generator. Existing values are preserved
-- (a uuid cast to text is just its same string, e.g.
--  'a1b2c3d4-e5f6-...' stays 'a1b2c3d4-e5f6-...' — still unique, still
--  works as a foreign key target, just no longer typed as uuid).
-- ---------------------------------------------------------------------
alter table courses  alter column id type text using id::text;
alter table courses  alter column id set default gen_short_id('C');

alter table subjects alter column id         type text using id::text;
alter table subjects alter column id         set default gen_short_id('SUB');
alter table subjects alter column course_id  type text using course_id::text;

alter table topics   alter column id         type text using id::text;
alter table topics   alter column id         set default gen_short_id('T');
alter table topics   alter column subject_id type text using subject_id::text;

alter table lectures  alter column id       type text using id::text;
alter table lectures  alter column id       set default gen_short_id('L');
alter table lectures  alter column topic_id type text using topic_id::text;

alter table tests    alter column id       type text using id::text;
alter table tests    alter column id       set default gen_short_id('TST');
alter table tests    alter column topic_id type text using topic_id::text;

alter table pyqs     alter column id       type text using id::text;
alter table pyqs     alter column id       set default gen_short_id('PYQ');
alter table pyqs     alter column topic_id type text using topic_id::text;

alter table books    alter column id        type text using id::text;
alter table books    alter column id        set default gen_short_id('B');
alter table books    alter column course_id type text using course_id::text;

alter table student_books alter column book_id type text using book_id::text;
-- student_books.student_id stays uuid (references profiles.id, see note above)

alter table enrollments alter column id        type text using id::text;
alter table enrollments alter column id        set default gen_short_id('ENR');
alter table enrollments alter column course_id type text using course_id::text;

alter table purchases alter column id        type text using id::text;
alter table purchases alter column id        set default gen_short_id('PUR');
alter table purchases alter column course_id type text using course_id::text;

-- attempts.ref_id points at tests/pyqs/lectures ids (now text) — retype it too.
-- attempts.course_id points at courses.id (now text).
-- attempts.student_id stays uuid (references profiles.id).
alter table attempts alter column id        type text using id::text;
alter table attempts alter column id        set default gen_short_id('ATT');
alter table attempts alter column ref_id    type text using ref_id::text;
alter table attempts alter column course_id type text using course_id::text;

-- ---------------------------------------------------------------------
-- PART 2b — recreate the foreign-key constraints, now text-to-text
-- ---------------------------------------------------------------------
alter table subjects       add constraint subjects_course_id_fkey       foreign key (course_id)  references courses(id)  on delete cascade;
alter table topics         add constraint topics_subject_id_fkey        foreign key (subject_id) references subjects(id) on delete cascade;
alter table lectures       add constraint lectures_topic_id_fkey        foreign key (topic_id)   references topics(id)   on delete cascade;
alter table tests          add constraint tests_topic_id_fkey           foreign key (topic_id)   references topics(id)   on delete cascade;
alter table pyqs           add constraint pyqs_topic_id_fkey            foreign key (topic_id)   references topics(id)   on delete cascade;
alter table books          add constraint books_course_id_fkey          foreign key (course_id)  references courses(id)  on delete set null;
alter table student_books  add constraint student_books_book_id_fkey    foreign key (book_id)    references books(id)    on delete cascade;
alter table enrollments    add constraint enrollments_course_id_fkey    foreign key (course_id)  references courses(id)  on delete cascade;
alter table purchases      add constraint purchases_course_id_fkey      foreign key (course_id)  references courses(id)  on delete cascade;

-- Recreate the *_public views (view definitions are dropped implicitly by
-- some retypes above on Postgres < 15; safe to just re-run them either way)
create or replace view tests_public as
  select id, topic_id, question, option_a, option_b, option_c, option_d,
         type, tolerance, test_name, test_type, is_file, file_name, file_mime, file_size
  from tests;

create or replace view pyqs_public as
  select id, topic_id, year, question, option_a, option_b, option_c, option_d,
         type, tolerance, pyq_name, pyq_type, is_file, file_name, file_mime, file_size
  from pyqs;

-- ---------------------------------------------------------------------
-- PART 2c — update the RPC functions to accept text ids instead of uuid
-- (student_id / auth.uid() is untouched — still uuid, from Supabase Auth)
-- ---------------------------------------------------------------------
create or replace function submit_answer(p_kind text, p_ref_id text, p_course_id text, p_selected text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_correct text; v_type text; v_tolerance numeric;
  v_is_correct boolean; v_points numeric;
  v_key text := auth.uid()::text || ':' || p_kind || ':' || p_ref_id;
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
  v_points := case when v_is_correct then 4 else -1 end;

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

create or replace function log_video_watch(p_lecture_id text, p_course_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_key text := auth.uid()::text || ':video:' || p_lecture_id;
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
-- PART 3 — students: keep profiles.id as-is (uuid, tied to Supabase Auth)
-- and add a separate, fully alphanumeric "Student ID" for display/roll-
-- number purposes. Existing students get one backfilled automatically.
-- =====================================================================
alter table profiles add column if not exists student_code text unique;

update profiles
set student_code = gen_short_id('STU')
where student_code is null;

alter table profiles alter column student_code set default gen_short_id('STU');

-- Auto-assign a student_code to every future signup too:
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, email, role, name, student_code)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'role', 'student'),
    new.raw_user_meta_data ->> 'name',
    gen_short_id('STU')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- =====================================================================
-- PART 4 — file-type guardrails
-- Books: must be a PDF (checked on the storage path/filename extension).
-- Tests/PYQs: when a file is attached, it must be a PDF or an Excel file
-- (checked on file_mime; is_file=false rows are untouched, e.g. plain
-- MCQ/MSQ/NAT questions typed directly with no attachment).
-- =====================================================================
alter table books drop constraint if exists books_storage_path_is_pdf;
alter table books add constraint books_storage_path_is_pdf
  check (storage_path ~* '\.pdf$');

alter table tests drop constraint if exists tests_file_is_pdf_or_excel;
alter table tests add constraint tests_file_is_pdf_or_excel
  check (
    is_file = false
    or file_mime is null
    or file_mime in (
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  );

alter table pyqs drop constraint if exists pyqs_file_is_pdf_or_excel;
alter table pyqs add constraint pyqs_file_is_pdf_or_excel
  check (
    is_file = false
    or file_mime is null
    or file_mime in (
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  );

-- =====================================================================
-- DONE. Next: your frontend (index.html / Netlify functions) needs a
-- matching small update — see the notes in chat for exactly what changes.
-- =====================================================================
