# GATE99 — Netlify + Supabase edition

Full rewrite of the original NocoDB/Express backend onto a stack that never sleeps
and stays on the free tier: **React (Vite) on Netlify** + **Netlify Functions** +
**Supabase (Postgres, Auth, Storage, Realtime)**.

## What changed from the old NocoDB version

| Old | New |
|---|---|
| Custom OTP emailed via Gmail SMTP (`mailer.js`) | Supabase Auth's built-in **email OTP** (`signInWithOtp` / `verifyOtp`) — no SMTP setup needed |
| Role from `userId` prefix (`M…`/`A…`/`S…`) | `profiles.role` column (`student` / `admin` / `mainadmin`), set via signup metadata + manual promotion |
| One `POST /` action-router endpoint | Frontend talks to Postgres **directly** through `supabase-js`, protected by Row Level Security — no generic CRUD endpoint to maintain |
| `correct` / `answerKey` stripped in JS before sending (`stripPaperFields`) | `correct`/`answer_key`/`content_enc`/`file_path` are **never selectable** by students at the database level (RLS + `tests_public`/`pyqs_public` views + `get_tests_public()` RPC) |
| Grading done in `actions.js` | Grading done inside Postgres via `submit_answer()` (SECURITY DEFINER) — the answer key never reaches the browser, not even in a network request |
| Signed book links minted by Express, streamed via `/book-stream/:id` | A single Netlify Function (`get-book-url`) re-checks entitlement with the service-role key and returns a Supabase Storage **signed URL**; range requests, caching, and CDN are handled by Supabase Storage itself |
| In-memory NocoDB request queue/cache/retry | Not needed — Supabase Postgres has no equivalent throttling to work around |

## 1. Create the Supabase project

1. https://supabase.com → New project.
2. SQL Editor → paste the entire contents of `supabase/schema.sql` → Run.
   This creates every table, RLS policy, the `tests_public`/`pyqs_public` views,
   the `submit_answer`/`log_video_watch` grading functions, the `books` (private)
   and `course-media` (public) storage buckets, and enables Realtime on the
   doubts board.
3. Project Settings → API → copy the **Project URL**, **anon public key**, and
   **service_role key** (keep the service role key secret — it only ever goes
   into Netlify env vars, never into the frontend).
4. Authentication → Providers → Email: make sure "Email OTP" is enabled
   (it is by default) and disable "Confirm email" if you want the very first
   OTP to also complete signup in one step.

## 2. Promote your first admin

Sign in once through the normal `/login` flow with the email you want to be
the main admin, then in the SQL editor:

```sql
update profiles set role = 'mainadmin' where email = 'you@example.com';
```

From then on, that account can create more `admin` accounts by updating
`profiles.role` for other students (add a small admin-only UI for this later,
or do it via SQL — the schema and RLS already support it).

## 3. Configure environment variables

```bash
cp .env.example .env
```

Fill in `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (safe to expose — RLS
protects the data) and, **in the Netlify dashboard only** (Site settings →
Environment variables, not in a committed file), `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` for the `get-book-url` function.

## 4. Run locally

```bash
npm install
npm run dev          # Vite dev server, http://localhost:5173
# in a second terminal, to also test the Netlify Function locally:
npx netlify dev       # http://localhost:8888, proxies /api/* to the function
```

## 5. Deploy to Netlify

1. Push this folder to a GitHub repo.
2. Netlify → Add new site → Import from Git → pick the repo.
   Build command and publish directory are already set in `netlify.toml`.
3. Site settings → Environment variables → add all four vars from
   `.env.example` (the `VITE_*` ones AND the function-only ones).
4. Deploy. Netlify Functions run on-demand (no cold "server asleep" state
   like Render free tier), and Supabase's free-tier pause only kicks in after
   **7 days with zero API requests** — normal traffic keeps it awake.

## 6. Uploading books

Storage → `books` bucket (private) → upload the PDF anywhere inside it, e.g.
`2026/thermodynamics-notes.pdf`. In Admin → Books, paste that same path into
"Storage path". Assign it to a student under Admin → Students → "Assign
book…". The student's "Read book" button then calls the `get-book-url`
function, which checks `student_books`/admin role before minting a signed
URL — the real storage path is never sent to the browser.

## What isn't ported yet (same architecture, next pass)

These existed in the original `actions.js` and follow the exact same
RLS + RPC pattern already established here — flag which one you want next:

- **Payments**: `purchases`/`bills`/`payment_settings` tables and their RLS
  are already in `schema.sql`; only the admin "verify purchase" UI and the
  student "submit transaction ID" form are still to be built.
- **Feedback board**: `feedbacks` table + RLS is ready; needs a form + admin
  reply UI.
- **Free courses** (`free_courses` table) and **PYQs** (`pyqs`/`pyqs_public`,
  mirrors Tests exactly): schema is ready, UI not yet built.
- **Chunked/large PDF upload + qpdf/ghostscript post-processing**: the
  original workaround (server disk + CLI tools) doesn't have a serverless
  equivalent — for files over Netlify Functions' body-size limit, use the
  Supabase JS client's resumable upload (`supabase.storage...upload` with
  `duplex: 'half'`) directly from the browser to the private bucket instead;
  Supabase Storage handles files up to 5GB without any chunking code needed.
