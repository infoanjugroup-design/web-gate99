import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

// A full "start test -> answer -> submit -> results" flow for one topic's
// tests or PYQs. Unlike the original NocoDB version this is based on, this
// NEVER fetches the correct answer to the browser: questions come from
// get_tests_public/get_pyqs_public (which drop the `correct` column
// entirely), and each answered question is graded one at a time via the
// submit_answer() RPC when the student hits Submit — same secure path the
// rest of the app already uses.
export default function QuizRunner({ topicId, courseId, kind, onClose }) {
  const [screen, setScreen] = useState('loading'); // 'loading' | 'quiz' | 'results' | 'error'
  const [items, setItems] = useState([]);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState({}); // id -> string | string[]
  const [results, setResults] = useState(null); // { rows: [{id, label, correct, points, unanswered}], score, total }
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState('');

  const rpcName = kind === 'pyq' ? 'get_pyqs_public' : 'get_tests_public';
  const label = kind === 'pyq' ? 'PYQ' : 'Test';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc(rpcName, { p_topic_id: topicId });
      if (cancelled) return;
      if (error) { setError(error.message); setScreen('error'); return; }
      if (!data || data.length === 0) { setError(`No ${label.toLowerCase()}s in this topic yet.`); setScreen('error'); return; }
      setItems(data);
      setScreen('quiz');
    })();
    return () => { cancelled = true; };
  }, [topicId, rpcName, label]);

  const current = items[index];
  const isAnswered = (q) => {
    const a = answers[q.id];
    if (q.type === 'MSQ') return Array.isArray(a) && a.length > 0;
    return a !== undefined && a !== '';
  };

  function setMcq(id, key) { setAnswers((a) => ({ ...a, [id]: key })); }
  function toggleMsq(id, key) {
    setAnswers((a) => {
      const cur = new Set(a[id] || []);
      cur.has(key) ? cur.delete(key) : cur.add(key);
      return { ...a, [id]: Array.from(cur) };
    });
  }
  function setNat(id, value) { setAnswers((a) => ({ ...a, [id]: value })); }

  async function submitQuiz() {
    setGrading(true);
    const rows = [];
    let score = 0;
    for (const q of items) {
      const raw = answers[q.id];
      const unanswered = q.type === 'MSQ' ? !raw || raw.length === 0 : raw === undefined || raw === '';
      if (unanswered) { rows.push({ id: q.id, question: q.question, unanswered: true }); continue; }
      const selected = Array.isArray(raw) ? raw.join(',') : String(raw);
      const { data, error } = await supabase.rpc('submit_answer', {
        p_kind: kind, p_ref_id: q.id, p_course_id: courseId, p_selected: selected,
      });
      if (error) { rows.push({ id: q.id, question: q.question, error: true }); continue; }
      if (data.correct) score++;
      rows.push({ id: q.id, question: q.question, correct: data.correct, points: data.points });
    }
    setResults({ rows, score, total: items.length });
    setGrading(false);
    setScreen('results');
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/95 backdrop-blur flex items-start justify-center overflow-y-auto py-8 px-4">
      <div className="w-full max-w-xl">
        <div className="flex justify-between items-center mb-4">
          <p className="label-mono">{label}</p>
          <button className="icon-close text-paper/60 hover:text-signal text-sm label-mono" onClick={onClose}>Close ✕</button>
        </div>

        {screen === 'loading' && (
          <div className="blueprint-panel p-10 text-center label-mono">Loading questions…</div>
        )}

        {screen === 'error' && (
          <div className="blueprint-panel p-6">
            <p className="text-alert text-sm">{error}</p>
            <button className="btn-ghost !py-1.5 text-sm mt-4" onClick={onClose}>Close</button>
          </div>
        )}

        {screen === 'quiz' && current && (
          <div>
            <div className="h-1.5 rounded-full bg-blueline/15 overflow-hidden mb-4">
              <div className="h-full bg-signal transition-all" style={{ width: `${((index + 1) / items.length) * 100}%` }} />
            </div>

            <div className="blueprint-panel p-5">
              <div className="flex justify-between items-center mb-3">
                <span className="label-mono">Question {index + 1} of {items.length}</span>
                <span className="label-mono text-signal">{current.type}{kind === 'pyq' && current.year ? ` · ${current.year}` : ''}</span>
              </div>
              <p className="mb-4">{current.question}</p>

              {current.type === 'MCQ' && (
                <div className="space-y-2">
                  {['A', 'B', 'C', 'D'].filter((k) => current[`option_${k.toLowerCase()}`]).map((k) => (
                    <label key={k} className={`flex items-center gap-2 text-sm border rounded-sm px-3 py-2 cursor-pointer ${answers[current.id] === k ? 'border-signal bg-signal/10' : 'border-blueline/30'}`}>
                      <input type="radio" name={`q-${current.id}`} checked={answers[current.id] === k} onChange={() => setMcq(current.id, k)} />
                      {k}. {current[`option_${k.toLowerCase()}`]}
                    </label>
                  ))}
                </div>
              )}

              {current.type === 'MSQ' && (
                <div className="space-y-2">
                  {['A', 'B', 'C', 'D'].filter((k) => current[`option_${k.toLowerCase()}`]).map((k) => {
                    const checked = (answers[current.id] || []).includes(k);
                    return (
                      <label key={k} className={`flex items-center gap-2 text-sm border rounded-sm px-3 py-2 cursor-pointer ${checked ? 'border-signal bg-signal/10' : 'border-blueline/30'}`}>
                        <input type="checkbox" checked={checked} onChange={() => toggleMsq(current.id, k)} />
                        {k}. {current[`option_${k.toLowerCase()}`]}
                      </label>
                    );
                  })}
                </div>
              )}

              {current.type === 'NAT' && (
                <input
                  className="field" type="number" step="any" placeholder="Enter numeric answer"
                  value={answers[current.id] ?? ''} onChange={(e) => setNat(current.id, e.target.value)}
                />
              )}

              <div className="flex items-center justify-between mt-5">
                <button className="btn-ghost !py-1.5 !px-4 text-sm" disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>Previous</button>
                {index < items.length - 1 ? (
                  <button className="btn-signal !py-1.5 !px-4 text-sm" onClick={() => setIndex((i) => i + 1)}>Next</button>
                ) : (
                  <button className="btn-signal !py-1.5 !px-4 text-sm" disabled={grading} onClick={submitQuiz}>{grading ? 'Grading…' : 'Submit'}</button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 mt-4">
              {items.map((q, i) => (
                <button
                  key={q.id}
                  onClick={() => setIndex(i)}
                  className={`w-8 h-8 rounded-full text-xs label-mono border flex items-center justify-center
                    ${i === index ? 'border-signal text-signal' : isAnswered(q) ? 'border-mint text-mint bg-mint/10' : 'border-blueline/30 text-paper/50'}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          </div>
        )}

        {screen === 'results' && results && (
          <div className="blueprint-panel p-6">
            <div className="text-center mb-6">
              <p className="font-mono text-3xl font-bold text-signal">{results.score} / {results.total}</p>
              <p className="label-mono mt-1">Correct answers</p>
            </div>
            <div className="space-y-2">
              {results.rows.map((r, i) => (
                <div key={r.id} className="flex justify-between items-center text-sm border-b border-blueline/15 py-2 gap-3">
                  <span className="truncate">Q{i + 1}. {r.question}</span>
                  <span className={`label-mono shrink-0 ${r.unanswered ? 'text-paper/40' : r.correct ? 'text-mint' : 'text-alert'}`}>
                    {r.unanswered ? 'Unanswered' : r.correct ? `Correct · +${r.points}` : `Wrong · ${r.points}`}
                  </span>
                </div>
              ))}
            </div>
            <button className="btn-ghost !py-1.5 text-sm mt-6 w-full" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
