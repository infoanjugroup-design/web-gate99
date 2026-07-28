import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

export default function Login() {
  const [step, setStep] = useState('email'); // 'email' | 'otp'
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const navigate = useNavigate();

  async function sendOtp(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true, data: name ? { name } : undefined },
    });
    setBusy(false);
    if (error) { setError(error.message); return; }
    setNotice(`We sent a 6-digit code to ${email}. It expires in 10 minutes.`);
    setStep('otp');
  }

  async function verifyOtp(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    const { error } = await supabase.auth.verifyOtp({ email, token: otp, type: 'email' });
    setBusy(false);
    if (error) { setError(error.message); return; }
    navigate('/dashboard');
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] grid place-items-center px-5 bg-blueprint bg-grid">
      <div className="blueprint-panel w-full max-w-sm p-7">
        <span className="reg-mark top-3 left-3 border-l border-t" />
        <span className="reg-mark top-3 right-3 border-r border-t" />
        <span className="reg-mark bottom-3 left-3 border-l border-b" />
        <span className="reg-mark bottom-3 right-3 border-r border-b" />

        <p className="label-mono mb-1">{step === 'email' ? 'Sign in / Register' : 'Verify code'}</p>
        <h1 className="text-2xl font-display font-bold mb-6">
          {step === 'email' ? 'Enter your email' : 'Check your inbox'}
        </h1>

        {error && <p className="text-alert text-sm mb-4 font-mono">{error}</p>}
        {notice && step === 'otp' && <p className="text-mint text-sm mb-4">{notice}</p>}

        {step === 'email' ? (
          <form onSubmit={sendOtp} className="space-y-4">
            <div>
              <label className="label-mono block mb-1.5">Name (first time only)</label>
              <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            </div>
            <div>
              <label className="label-mono block mb-1.5">Email</label>
              <input
                className="field" type="email" required value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
              />
            </div>
            <button disabled={busy} className="btn-signal w-full">{busy ? 'Sending…' : 'Send code'}</button>
          </form>
        ) : (
          <form onSubmit={verifyOtp} className="space-y-4">
            <div>
              <label className="label-mono block mb-1.5">6-digit code</label>
              <input
                className="field font-mono tracking-[0.4em] text-center text-lg" required
                value={otp} onChange={(e) => setOtp(e.target.value)} maxLength={8} inputMode="numeric"
              />
            </div>
            <button disabled={busy} className="btn-signal w-full">{busy ? 'Verifying…' : 'Verify & continue'}</button>
            <button type="button" onClick={() => setStep('email')} className="text-xs label-mono underline block mx-auto">
              Use a different email
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
