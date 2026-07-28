import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function Home() {
  const [courses, setCourses] = useState([]);

  useEffect(() => {
    supabase.from('courses').select('*').order('created_at', { ascending: false }).then(({ data }) => setCourses(data ?? []));
  }, []);

  return (
    <div>
      <section className="bg-blueprint bg-grid border-b border-blueline/20">
        <div className="max-w-6xl mx-auto px-5 py-24">
          <p className="label-mono mb-3">GATE Exam Preparation</p>
          <h1 className="font-display text-4xl sm:text-5xl font-bold max-w-2xl leading-tight">
            Precision practice for the exam that runs on precision.
          </h1>
          <p className="text-paper/60 max-w-lg mt-4">
            Structured courses, timed tests scored the moment you submit, and previous-year papers —
            all in one place.
          </p>
          <Link to="/login" className="btn-signal mt-8 inline-flex">Get started</Link>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-5 py-16">
        <h2 className="font-display text-xl font-bold mb-6">Courses</h2>
        <div className="grid sm:grid-cols-3 gap-5">
          {courses.map((c) => (
            <div key={c.id} className="blueprint-panel p-5">
              <p className="label-mono mb-1">₹{c.fees}</p>
              <h3 className="font-display font-bold">{c.course_name}</h3>
            </div>
          ))}
          {courses.length === 0 && <p className="text-paper/50">Courses will appear here once the admin publishes them.</p>}
        </div>
      </section>
    </div>
  );
}
