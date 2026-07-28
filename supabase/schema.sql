-- =====================================================================
--  select the real column through these)
-- =====================================================================
-- GATE99 — migration: "enrollment = access to everything in that course"
-- Paste into Supabase SQL Editor and run once. Safe to re-run.
--
-- What this adds on top of schema.sql:
--   1. enroll_free_course()  — students can self-enroll in a ₹0 course
--      (previously blocked: enrollments_write RLS is admin-only, and the
--      old StudentDashboard "Enroll" button was silently failing for
--      every course, free or paid).
--   2. verify_purchase()     — the admin action for "payment verified".
--      One click: marks the purchase verified/rejected, creates the
--      enrollment row, and writes a bill — atomically, server-side.
--   3. books_read policy widened — a student with an `enrollments` row
--      for a course now sees every book on that course automatically,
--      no manual per-student "Assign book" step needed anymore.
--      (student_books still works too, for one-off assignments outside
--      a course, e.g. a bonus book.)
--
-- Lectures, tests (via get_tests_public/submit_answer) and pyqs (via
-- get_pyqs_public/submit_answer) already key off `enrollments` in
-- schema.sql, so once step 1/2 create that row, they unlock automatically.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Self-enroll in a free course
-- ---------------------------------------------------------------------
create or replace function enroll_free_course(p_course_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fees numeric;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select fees into v_fees from courses where id = p_course_id;
  if v_fees is null then
    raise exception 'Course not found';
  end if;
  if v_fees > 0 then
    raise exception 'This course requires payment verification — use the purchase form.';
  end if;

  insert into enrollments (student_id, course_id)
  values (auth.uid(), p_course_id)
  on conflict (student_id, course_id) do nothing;
end;
$$;

grant execute on function enroll_free_course(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2) Admin verifies (or rejects) a purchase
--    approve = true  -> status='verified', creates enrollment + bill
--    approve = false -> status='rejected', nothing else happens
-- ---------------------------------------------------------------------
create or replace function verify_purchase(p_purchase_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase purchases%rowtype;
  v_bill_no text;
begin
  if not is_admin() then
    raise exception 'Admin only';
  end if;

  select * into v_purchase from purchases where id = p_purchase_id;
  if not found then
    raise exception 'Purchase not found';
  end if;
  if v_purchase.status <> 'pending' then
    raise exception 'Purchase already %', v_purchase.status;
  end if;

  if p_approve then
    v_bill_no := coalesce(v_purchase.bill_no, 'GATE99-' || to_char(now(), 'YYYYMMDD') || '-' || substr(v_purchase.id::text, 1, 8));

    update purchases
      set status = 'verified', verified_at = now(), bill_no = v_bill_no
      where id = p_purchase_id;

    insert into enrollments (student_id, course_id)
    values (v_purchase.student_id, v_purchase.course_id)
    on conflict (student_id, course_id) do nothing;

    insert into bills (student_id, course_id, bill_no, amount)
    values (v_purchase.student_id, v_purchase.course_id, v_bill_no, v_purchase.amount);
  else
    update purchases set status = 'rejected' where id = p_purchase_id;
  end if;
end;
$$;

grant execute on function verify_purchase(uuid, boolean) to authenticated;
-- (function body still checks is_admin() itself, so granting execute to
-- all authenticated users is safe — a student calling this just gets the
-- 'Admin only' exception.)

-- ---------------------------------------------------------------------
-- 3) Books: visible to anyone enrolled in the book's course, not just
--    students the admin manually assigned via student_books.
-- ---------------------------------------------------------------------
drop policy if exists "books_read" on books;
create policy "books_read" on books for select using (
  is_admin()
  or exists (select 1 from student_books sb where sb.book_id = books.id and sb.student_id = auth.uid())
  or exists (select 1 from enrollments e where e.course_id = books.course_id and e.student_id = auth.uid())
);
