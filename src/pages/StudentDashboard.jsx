import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import BookReader from '../components/BookReader';
import QuizRunner from '../components/QuizRunner';

export default function StudentDashboard() {
  const { user } = useAuth();
  const [courses, setCourses] = useState([]);
  const [enrolledIds, setEnrolledIds] = useState(new Set());
  const [purchases, setPurchases] = useState([]); // this student's purchase history
  const [perf, setPerf] = useState(null);
  const [openCourseId, setOpenCourseId] = useState(null);
  const [buyCourseId, setBuyCourseId] = useState(null); // course currently showing the purchase form
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [readingBook, setReadingBook] = useState(null);     // book object -> opens BookReader
  const [activeQuiz, setActiveQuiz] = useState(null);       // { topicId, courseId, kind } -> opens QuizRunner

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: allCourses }, { data: enrollments }, { data: myPurchases }, { data: perfRow }, { data: myBooks }] = await Promise.all([
      supabase.from('courses').select('*').order('created_at', { ascending: false }),
      supabase.from('enrollments').select('course_id').eq('student_id', user.id),
      supabase.from('purchases').select('*').eq('student_id', user.id).order('created_at', { ascending: false }),
      supabase.from('perf_summary').select('*').eq('student_id', user.id).maybeSingle(),
      supabase.from('books').select('*'), // RLS already limits this to enrolled/assigned books
    ]);
    setCourses(allCourses ?? []);
    setEnrolledIds(new Set((enrollments ?? []).map((e) => e.course_id)));
    setPurchases(myPurchases ?? []);
    setPerf(perfRow ?? null);
    setBooks(myBooks ?? []);
    setLoading(false);
  }, [user.id]);

  useEffect(() => { load(); }, [load]);

  async function enrollFree(courseId) {
    const { error } = await supabase.rpc('enroll_free_course', { p_course_id: courseId });
    if (error) { alert(error.message); return; }
    load();
  }

  // Latest purchase for a course, if any — drives the pending/rejected badge.
  const purchaseFor = (courseId) => purchases.find((p) => p.course_id === courseId);

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
          {courses.map((c) => {
            const pending = purchaseFor(c.id);
            return (
              <div key={c.id} className="blueprint-panel p-5">
                <p className="label-mono">{c.fees > 0 ? `₹${c.fees}` : 'Free'}</p>
                <h3 className="font-display font-bold text-lg mb-3">{c.course_name}</h3>

                {enrolledIds.has(c.id) ? (
                  <button className="btn-signal !py-1.5 text-sm" onClick={() => setOpenCourseId(openCourseId === c.id ? null : c.id)}>
                    {openCourseId === c.id ? 'Close' : 'Open course'}
                  </button>
                ) : c.fees === 0 ? (
                  <button className="btn-ghost !py-1.5 text-sm" onClick={() => enrollFree(c.id)}>Enroll</button>
                ) : pending?.status === 'pending' ? (
                  <p className="label-mono text-signal">Payment submitted — awaiting verification</p>
                ) : pending?.status === 'rejected' ? (
                  <div className="space-y-2">
                    <p className="label-mono text-alert">Last payment was rejected</p>
                    <button className="btn-ghost !py-1.5 text-sm" onClick={() => setBuyCourseId(c.id)}>Submit payment again</button>
                  </div>
                ) : (
                  <button className="btn-ghost !py-1.5 text-sm" onClick={() => setBuyCourseId(c.id)}>Buy course</button>
                )}

                {buyCourseId === c.id && (
                  <PurchaseForm
                    course={c}
                    onDone={() => { setBuyCourseId(null); load(); }}
                    onCancel={() => setBuyCourseId(null)}
                  />
                )}
                {openCourseId === c.id && (
                  <CourseTree courseId={c.id} onStartQuiz={(topicId, kind) => setActiveQuiz({ topicId, courseId: c.id, kind })} />
                )}
              </div>
            );
          })}
          {courses.length === 0 && <p className="text-paper/50">No courses published yet.</p>}
        </div>
      </section>

      <section>
        <h2 className="font-display text-xl font-bold mb-4">My books</h2>
        <div className="grid sm:grid-cols-3 gap-4">
          {books.map((b) => <BookCard key={b.id} book={b} onOpen={() => setReadingBook(b)} />)}
          {books.length === 0 && <p className="text-paper/50">No books available yet — books unlock automatically once you're enrolled in their course.</p>}
        </div>
      </section>

      {readingBook && <BookReader book={readingBook} onClose={() => setReadingBook(null)} />}
      {activeQuiz && (
        <QuizRunner
          topicId={activeQuiz.topicId}
          courseId={activeQuiz.courseId}
          kind={activeQuiz.kind}
          onClose={() => setActiveQuiz(null)}
        />
      )}
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

// Payment settings (UPI/QR) + a form to submit a transaction ID for admin review.
function PurchaseForm({ course, onDone, onCancel }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState(null);
  const [transactionId, setTransactionId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('UPI');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.from('payment_settings').select('*').eq('id', 1).maybeSingle().then(({ data }) => setSettings(data));
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (!transactionId.trim()) return;
    setBusy(true); setError('');
    const { error } = await supabase.from('purchases').insert({
      student_id: user.id,
      course_id: course.id,
      transaction_id: transactionId.trim(),
      payment_method: paymentMethod,
      amount: course.fees,
    });
    setBusy(false);
    if (error) { setError(error.message); return; }
    onDone();
  }

  return (
    <form onSubmit={submit} className="mt-4 pt-4 border-t border-blueline/20 space-y-3">
      <p className="label-mono">Pay ₹{course.fees}</p>
      {settings?.upi_id && <p className="text-sm">UPI ID: <span className="font-mono text-signal">{settings.upi_id}</span></p>}
      {settings?.qr_url && <img src={settings.qr_url} alt="Payment QR" className="w-32 h-32 object-contain border border-blueline/30 rounded-sm" />}
      {settings?.account_no && (
        <p className="text-xs text-paper/60 font-mono">A/C {settings.account_no} · IFSC {settings.ifsc}</p>
      )}

      {error && <p className="text-alert text-sm">{error}</p>}
      <select className="field !py-1.5 text-sm" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
        <option value="UPI">UPI</option>
        <option value="Bank transfer">Bank transfer</option>
        <option value="Other">Other</option>
      </select>
      <input
        className="field !py-1.5 text-sm" required placeholder="Transaction / reference ID"
        value={transactionId} onChange={(e) => setTransactionId(e.target.value)}
      />
      <div className="flex gap-2">
        <button disabled={busy} className="btn-signal !py-1.5 text-sm">{busy ? 'Submitting…' : 'Submit for verification'}</button>
        <button type="button" className="btn-ghost !py-1.5 text-sm" onClick={onCancel}>Cancel</button>
      </div>
      <p className="text-xs text-paper/50">
        An admin verifies this manually. Once verified, the course — lectures, tests, PYQs and books — unlocks automatically.
      </p>
    </form>
  );
}

function CourseTree({ courseId, onStartQuiz }) {
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
                {openTopicId === t.id && (
                  <div className="mt-2 ml-3 flex gap-2">
                    <button className="btn-signal !py-1 !px-3 text-xs" onClick={() => onStartQuiz(t.id, 'test')}>Start test</button>
                    <button className="btn-ghost !py-1 !px-3 text-xs" onClick={() => onStartQuiz(t.id, 'pyq')}>Start PYQs</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function BookCard({ book, onOpen }) {
  return (
    <div className="blueprint-panel p-4">
      <h4 className="font-display font-semibold mb-3">{book.book_name}</h4>
      <button className="btn-signal !py-1.5 text-sm" onClick={onOpen}>Read book</button>
    </div>
  );
}
