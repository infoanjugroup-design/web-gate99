import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';

export default function StudentDashboard() {
  const { user } = useAuth();
  const [courses, setCourses] = useState([]);
  const [enrolledIds, setEnrolledIds] = useState(new Set());
  const [perf, setPerf] = useState(null);
  const [openCourseId, setOpenCourseId] = useState(null);
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: allCourses }, { data: enrollments }, { data: perfRow }, { data: myBooks }] = await Promise.all([
      supabase.from('courses').select('*').order('created_at', { ascending: false }),
      supabase.from('enrollments').select('course_id').eq('student_id', user.id),
      supabase.from('perf_summary').select('*').eq('student_id', user.id).maybeSingle(),
      supabase.from('books').select('*'), // RLS already limits this to owned books
    ]);
    setCourses(allCourses ?? []);
    setEnrolledIds(new Set((enrollments ?? []).map((e) => e.course_id)));
    setPerf(perfRow ?? null);
    setBooks(myBooks ?? []);
    setLoading(false);
  }, [user.id]);

  useEffect(() => { load(); }, [load]);

  async function enrollFree(courseId) {
    const { error } = await supabase.from('enrollments').insert({ student_id: user.id, course_id: courseId });
    if (error) { alert('Could not enroll — this may be a paid course (payment flow not shown in this build).'); return; }
    load();
  }

  if (loading) return <p className="p-8 label-mono">Loading dashboard…</p>;

  return (
    <div className="max-w-6xl mx-auto px-5 py-10 space-y-10">
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label="Points" value={perf?.total_points ?? 0} />
        <Stat label="Correct" value={perf?.correct_count ?? 0} accent="text-mint" />
        <Stat label="Wrong" value={perf?.wrong_count ?? 0} accent="text-alert" />
        <Stat label="Videos watched" value={perf?.video_count ?? 0} />
      </section>

      <section>
        <h2 className="font-display text-xl font-bold mb-4">Courses</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          {courses.map((c) => (
            <div key={c.id} className="blueprint-panel p-5">
              <p className="label-mono">₹{c.fees}</p>
              <h3 className="font-display font-bold text-lg mb-3">{c.course_name}</h3>
              {enrolledIds.has(c.id) ? (
                <button className="btn-signal !py-1.5 text-sm" onClick={() => setOpenCourseId(openCourseId === c.id ? null : c.id)}>
                  {openCourseId === c.id ? 'Close' : 'Open course'}
                </button>
              ) : (
                <button className="btn-ghost !py-1.5 text-sm" onClick={() => enrollFree(c.id)}>Enroll</button>
              )}
              {openCourseId === c.id && <CourseTree courseId={c.id} />}
            </div>
          ))}
          {courses.length === 0 && <p className="text-paper/50">No courses published yet.</p>}
        </div>
      </section>

      <section>
        <h2 className="font-display text-xl font-bold mb-4">My books</h2>
        <div className="grid sm:grid-cols-3 gap-4">
          {books.map((b) => <BookCard key={b.id} book={b} />)}
          {books.length === 0 && <p className="text-paper/50">No books assigned to you yet.</p>}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, accent = 'text-signal' }) {
  return (
    <div className="blueprint-panel p-4">
      <p className="label-mono mb-1">{label}</p>
      <p className={`font-mono text-2xl font-semibold ${accent}`}>{value}</p>
    </div>
  );
}

function CourseTree({ courseId }) {
  const [subjects, setSubjects] = useState([]);
  const [topicsBySubject, setTopicsBySubject] = useState({});
  const [openTopicId, setOpenTopicId] = useState(null);

  useEffect(() => {
    (async () => {
      const { data: subs } = await supabase.from('subjects').select('*').eq('course_id', courseId);
      setSubjects(subs ?? []);
      const map = {};
      for (const s of subs ?? []) {
        const { data: topics } = await supabase.from('topics').select('*').eq('subject_id', s.id);
        map[s.id] = topics ?? [];
      }
      setTopicsBySubject(map);
    })();
  }, [courseId]);

  return (
    <div className="mt-4 space-y-3 border-t border-blueline/20 pt-4">
      {subjects.map((s) => (
        <div key={s.id}>
          <p className="font-display font-semibold text-sm text-blueline">{s.subject_name}</p>
          <ul className="ml-3 mt-1 space-y-1">
            {(topicsBySubject[s.id] ?? []).map((t) => (
              <li key={t.id}>
                <button className="text-sm underline decoration-blueline/50 hover:text-signal" onClick={() => setOpenTopicId(openTopicId === t.id ? null : t.id)}>
                  {t.topic_name}
                </button>
                {openTopicId === t.id && <TopicTests topicId={t.id} courseId={courseId} />}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function TopicTests({ topicId, courseId }) {
  const [tests, setTests] = useState([]);
  const [active, setActive] = useState(null); // test being answered
  const [selected, setSelected] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc('get_tests_public', { p_topic_id: topicId });
      if (!error) setTests(data ?? []);
    })();
  }, [topicId]);

  async function submit() {
    const { data, error } = await supabase.rpc('submit_answer', {
      p_kind: 'test', p_ref_id: active.id, p_course_id: courseId, p_selected: selected,
    });
    if (error) { alert(error.message); return; }
    setResult(data);
  }

  return (
    <div className="mt-2 ml-3 space-y-2">
      {tests.map((t) => (
        <div key={t.id} className="blueprint-panel p-3">
          <p className="text-sm mb-2">{t.question}</p>
          {active?.id === t.id ? (
            <div className="space-y-2">
              {['A', 'B', 'C', 'D'].map((opt) => (
                <label key={opt} className="flex items-center gap-2 text-sm">
                  <input type="radio" name={`t-${t.id}`} value={opt} checked={selected === opt} onChange={() => setSelected(opt)} />
                  {t[`option_${opt.toLowerCase()}`]}
                </label>
              ))}
              <div className="flex items-center gap-3">
                <button className="btn-signal !py-1 !px-3 text-xs" onClick={submit} disabled={!selected}>Submit</button>
                {result && (
                  <span className={result.correct ? 'text-mint font-mono text-sm' : 'text-alert font-mono text-sm'}>
                    {result.correct ? `Correct · +${result.points}` : `Wrong · ${result.points}`}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <button className="btn-ghost !py-1 !px-3 text-xs" onClick={() => { setActive(t); setSelected(''); setResult(null); }}>
              Attempt
            </button>
          )}
        </div>
      ))}
      {tests.length === 0 && <p className="text-xs text-paper/40">No tests in this topic yet.</p>}
    </div>
  );
}

function BookCard({ book }) {
  const [busy, setBusy] = useState(false);

  async function openBook() {
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/get-book-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ bookId: book.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not open book');
      window.open(json.url, '_blank', 'noopener');
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="blueprint-panel p-4">
      <h4 className="font-display font-semibold mb-3">{book.book_name}</h4>
      <button className="btn-signal !py-1.5 text-sm" onClick={openBook} disabled={busy}>
        {busy ? 'Opening…' : 'Read book'}
      </button>
    </div>
  );
}
