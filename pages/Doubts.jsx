import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';

export default function Doubts() {
  const { user, profile } = useAuth();
  const [doubts, setDoubts] = useState([]);
  const [replies, setReplies] = useState({}); // doubt_id -> [reply]
  const [message, setMessage] = useState('');
  const [replyDrafts, setReplyDrafts] = useState({});

  const loadAll = useCallback(async () => {
    const { data: d } = await supabase.from('doubts').select('*').order('created_at', { ascending: false });
    setDoubts(d ?? []);
    const { data: r } = await supabase.from('doubt_replies').select('*').order('created_at', { ascending: true });
    const grouped = {};
    (r ?? []).forEach((row) => { (grouped[row.doubt_id] ??= []).push(row); });
    setReplies(grouped);
  }, []);

  useEffect(() => {
    loadAll();
    // Live updates: any insert/update on doubts or doubt_replies refreshes the board
    // for everyone connected — no polling, no manual refresh needed.
    const channel = supabase
      .channel('doubts-board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'doubts' }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'doubt_replies' }, loadAll)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [loadAll]);

  async function postDoubt(e) {
    e.preventDefault();
    if (!message.trim()) return;
    const { error } = await supabase.from('doubts').insert({ student_id: user.id, name: profile?.name, message: message.trim() });
    if (!error) setMessage('');
  }

  async function postReply(doubtId) {
    const text = (replyDrafts[doubtId] || '').trim();
    if (!text) return;
    await supabase.from('doubt_replies').insert({ doubt_id: doubtId, student_id: user.id, name: profile?.name, message: text });
    setReplyDrafts((d) => ({ ...d, [doubtId]: '' }));
  }

  return (
    <div className="max-w-3xl mx-auto px-5 py-10 space-y-6">
      <h1 className="font-display text-xl font-bold">Doubts board</h1>

      <form onSubmit={postDoubt} className="blueprint-panel p-4 space-y-3">
        <textarea className="field" rows={3} placeholder="Ask something…" value={message} onChange={(e) => setMessage(e.target.value)} />
        <button className="btn-signal !py-1.5 text-sm">Post</button>
      </form>

      <div className="space-y-4">
        {doubts.map((d) => (
          <div key={d.id} className="blueprint-panel p-4">
            <p className="label-mono">{d.name || 'Student'}</p>
            <p className="mb-3">{d.message}</p>
            <div className="ml-3 space-y-2 border-l border-blueline/20 pl-3">
              {(replies[d.id] ?? []).map((r) => (
                <p key={r.id} className={`text-sm ${r.is_correct ? 'text-mint' : ''}`}>
                  <span className="label-mono mr-2">{r.name || 'Student'}</span>{r.message}
                </p>
              ))}
              <div className="flex gap-2">
                <input
                  className="field !py-1 text-sm" placeholder="Reply…"
                  value={replyDrafts[d.id] || ''}
                  onChange={(e) => setReplyDrafts((cur) => ({ ...cur, [d.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && postReply(d.id)}
                />
                <button className="btn-ghost !py-1 !px-3 text-xs" onClick={() => postReply(d.id)}>Send</button>
              </div>
            </div>
          </div>
        ))}
        {doubts.length === 0 && <p className="text-paper/50">No doubts posted yet — be the first.</p>}
      </div>
    </div>
  );
}
