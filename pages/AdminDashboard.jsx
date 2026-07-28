import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

const TABS = ['Courses', 'Subjects', 'Topics', 'Tests', 'Books', 'Students'];

export default function AdminDashboard() {
  const [tab, setTab] = useState('Courses');
  return (
    <div className="max-w-6xl mx-auto px-5 py-10">
      <h1 className="font-display text-xl font-bold mb-6">Admin</h1>
      <div className="flex gap-2 mb-8 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`label-mono px-3 py-1.5 rounded-sm border ${tab === t ? 'border-signal text-signal' : 'border-blueline/30 text-paper/70'}`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'Courses' && <CoursesPanel />}
      {tab === 'Subjects' && <RefPanel table="subjects" parentTable="courses" parentKey="course_id" nameField="subject_name" parentLabel="Course" />}
      {tab === 'Topics' && <RefPanel table="topics" parentTable="subjects" parentKey="subject_id" nameField="topic_name" parentLabel="Subject" />}
      {tab === 'Tests' && <TestsPanel />}
      {tab === 'Books' && <BooksPanel />}
      {tab === 'Students' && <StudentsPanel />}
    </div>
  );
}

function CoursesPanel() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ course_name: '', fees: 0, course_image: '' });

  async function load() { const { data } = await supabase.from('courses').select('*').order('created_at', { ascending: false }); setRows(data ?? []); }
  useEffect(() => { load(); }, []);

  async function save(e) {
    e.preventDefault();
    const { error } = await supabase.from('courses').insert(form);
    if (error) { alert(error.message); return; }
    setForm({ course_name: '', fees: 0, course_image: '' });
    load();
  }
  async function remove(id) { await supabase.from('courses').delete().eq('id', id); load(); }

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <form onSubmit={save} className="blueprint-panel p-5 space-y-3 h-fit">
        <p className="label-mono">New course</p>
        <input className="field" placeholder="Course name" required value={form.course_name} onChange={(e) => setForm({ ...form, course_name: e.target.value })} />
        <input className="field" type="number" placeholder="Fees (0 = free)" value={form.fees} onChange={(e) => setForm({ ...form, fees: Number(e.target.value) })} />
        <input className="field" placeholder="Image URL (optional)" value={form.course_image} onChange={(e) => setForm({ ...form, course_image: e.target.value })} />
        <button className="btn-signal !py-1.5 text-sm">Add course</button>
      </form>
      <div className="space-y-2">
        {rows.map((c) => (
          <div key={c.id} className="blueprint-panel p-3 flex justify-between items-center">
            <span>{c.course_name} <span className="label-mono ml-2">₹{c.fees}</span></span>
            <button className="text-alert text-xs label-mono" onClick={() => remove(c.id)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Generic panel for Subjects/Topics — both are "name + parent_id" shaped.
function RefPanel({ table, parentTable, parentKey, nameField, parentLabel }) {
  const [rows, setRows] = useState([]);
  const [parents, setParents] = useState([]);
  const [form, setForm] = useState({ [parentKey]: '', [nameField]: '' });

  async function load() {
    const { data: p } = await supabase.from(parentTable).select('*');
    setParents(p ?? []);
    const { data: r } = await supabase.from(table).select('*');
    setRows(r ?? []);
  }
  useEffect(() => { load(); }, [table]);

  async function save(e) {
    e.preventDefault();
    const { error } = await supabase.from(table).insert(form);
    if (error) { alert(error.message); return; }
    setForm({ [parentKey]: '', [nameField]: '' });
    load();
  }
  async function remove(id) { await supabase.from(table).delete().eq('id', id); load(); }

  const parentName = (id) => parents.find((p) => p.id === id)?.course_name || parents.find((p) => p.id === id)?.subject_name || id;

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <form onSubmit={save} className="blueprint-panel p-5 space-y-3 h-fit">
        <p className="label-mono">New {table.slice(0, -1)}</p>
        <select className="field" required value={form[parentKey]} onChange={(e) => setForm({ ...form, [parentKey]: e.target.value })}>
          <option value="">{parentLabel}…</option>
          {parents.map((p) => <option key={p.id} value={p.id}>{p.course_name || p.subject_name}</option>)}
        </select>
        <input className="field" placeholder="Name" required value={form[nameField]} onChange={(e) => setForm({ ...form, [nameField]: e.target.value })} />
        <button className="btn-signal !py-1.5 text-sm">Add</button>
      </form>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="blueprint-panel p-3 flex justify-between items-center">
            <span>{r[nameField]} <span className="label-mono ml-2">{parentName(r[parentKey])}</span></span>
            <button className="text-alert text-xs label-mono" onClick={() => remove(r.id)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TestsPanel() {
  const [topics, setTopics] = useState([]);
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ topic_id: '', question: '', option_a: '', option_b: '', option_c: '', option_d: '', correct: 'A', type: 'MCQ' });

  async function load() {
    const { data: t } = await supabase.from('topics').select('*');
    setTopics(t ?? []);
    const { data: r } = await supabase.from('tests').select('*'); // admin-only table, full row incl. `correct`
    setRows(r ?? []);
  }
  useEffect(() => { load(); }, []);

  async function save(e) {
    e.preventDefault();
    const { error } = await supabase.from('tests').insert(form);
    if (error) { alert(error.message); return; }
    setForm({ topic_id: '', question: '', option_a: '', option_b: '', option_c: '', option_d: '', correct: 'A', type: 'MCQ' });
    load();
  }
  async function remove(id) { await supabase.from('tests').delete().eq('id', id); load(); }

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <form onSubmit={save} className="blueprint-panel p-5 space-y-3 h-fit">
        <p className="label-mono">New question</p>
        <select className="field" required value={form.topic_id} onChange={(e) => setForm({ ...form, topic_id: e.target.value })}>
          <option value="">Topic…</option>
          {topics.map((t) => <option key={t.id} value={t.id}>{t.topic_name}</option>)}
        </select>
        <textarea className="field" placeholder="Question" required value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} />
        {['a', 'b', 'c', 'd'].map((k) => (
          <input key={k} className="field" placeholder={`Option ${k.toUpperCase()}`} value={form[`option_${k}`]} onChange={(e) => setForm({ ...form, [`option_${k}`]: e.target.value })} />
        ))}
        <div className="flex gap-2">
          <select className="field" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="MCQ">MCQ</option><option value="MSQ">MSQ</option><option value="NAT">NAT</option>
          </select>
          <input className="field" placeholder="Correct (A / A,C / numeric)" value={form.correct} onChange={(e) => setForm({ ...form, correct: e.target.value })} />
        </div>
        <button className="btn-signal !py-1.5 text-sm">Add question</button>
      </form>
      <div className="space-y-2 max-h-[32rem] overflow-y-auto pr-1">
        {rows.map((r) => (
          <div key={r.id} className="blueprint-panel p-3 flex justify-between items-start gap-3">
            <div>
              <p className="text-sm">{r.question}</p>
              <p className="label-mono">Answer: {r.correct} · {r.type}</p>
            </div>
            <button className="text-alert text-xs label-mono shrink-0" onClick={() => remove(r.id)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function BooksPanel() {
  const [rows, setRows] = useState([]);
  const [courses, setCourses] = useState([]);
  const [form, setForm] = useState({ book_name: '', course_id: '', storage_path: '' });

  async function load() {
    const { data: c } = await supabase.from('courses').select('*');
    setCourses(c ?? []);
    const { data: b } = await supabase.from('books').select('*');
    setRows(b ?? []);
  }
  useEffect(() => { load(); }, []);

  async function save(e) {
    e.preventDefault();
    const { error } = await supabase.from('books').insert(form);
    if (error) { alert(error.message); return; }
    setForm({ book_name: '', course_id: '', storage_path: '' });
    load();
  }

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <form onSubmit={save} className="blueprint-panel p-5 space-y-3 h-fit">
        <p className="label-mono">New book</p>
        <p className="text-xs text-paper/50">
          Upload the PDF to the private <code>books</code> storage bucket first (Supabase dashboard → Storage),
          then paste its path here, e.g. <code>2026/thermo-notes.pdf</code>.
        </p>
        <input className="field" placeholder="Book name" required value={form.book_name} onChange={(e) => setForm({ ...form, book_name: e.target.value })} />
        <select className="field" required value={form.course_id} onChange={(e) => setForm({ ...form, course_id: e.target.value })}>
          <option value="">Course…</option>
          {courses.map((c) => <option key={c.id} value={c.id}>{c.course_name}</option>)}
        </select>
        <input className="field" placeholder="Storage path in 'books' bucket" required value={form.storage_path} onChange={(e) => setForm({ ...form, storage_path: e.target.value })} />
        <button className="btn-signal !py-1.5 text-sm">Add book</button>
      </form>
      <div className="space-y-2">
        {rows.map((b) => <div key={b.id} className="blueprint-panel p-3">{b.book_name}</div>)}
      </div>
    </div>
  );
}

function StudentsPanel() {
  const [students, setStudents] = useState([]);
  const [books, setBooks] = useState([]);

  async function load() {
    const { data: s } = await supabase.from('profiles').select('*').eq('role', 'student');
    setStudents(s ?? []);
    const { data: b } = await supabase.from('books').select('*');
    setBooks(b ?? []);
  }
  useEffect(() => { load(); }, []);

  async function toggleBlock(s) {
    await supabase.from('profiles').update({ blocked: !s.blocked }).eq('id', s.id);
    load();
  }

  async function assignBook(studentId, bookId) {
    if (!bookId) return;
    await supabase.from('student_books').insert({ student_id: studentId, book_id: bookId });
    alert('Assigned.');
  }

  return (
    <div className="space-y-2">
      {students.map((s) => (
        <div key={s.id} className="blueprint-panel p-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p>{s.name || '(no name)'} <span className="label-mono ml-2">{s.email}</span></p>
            {s.blocked && <p className="text-alert text-xs label-mono">Blocked</p>}
          </div>
          <div className="flex items-center gap-2">
            <select className="field !py-1 text-xs w-40" onChange={(e) => assignBook(s.id, e.target.value)} defaultValue="">
              <option value="">Assign book…</option>
              {books.map((b) => <option key={b.id} value={b.id}>{b.book_name}</option>)}
            </select>
            <button className="btn-ghost !py-1 !px-3 text-xs" onClick={() => toggleBlock(s)}>
              {s.blocked ? 'Unblock' : 'Block'}
            </button>
          </div>
        </div>
      ))}
      {students.length === 0 && <p className="text-paper/50">No students yet.</p>}
    </div>
  );
}
