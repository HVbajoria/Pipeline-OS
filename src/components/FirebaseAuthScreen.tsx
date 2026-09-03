import { useState, type FormEvent } from 'react';
import { Chrome, LockKeyhole, Mail, UserPlus } from 'lucide-react';
import {
  registerWithEmail,
  signInWithEmail,
  signInWithGoogle
} from '../client/firebaseAuth';

function friendlyAuthError(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return 'The email or password is incorrect.';
    case 'auth/email-already-in-use':
      return 'An account already exists for this email. Sign in instead.';
    case 'auth/weak-password':
      return 'Use a password with at least six characters.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google sign-in popup. Allow popups and try again.';
    case 'auth/operation-not-allowed':
      return 'This sign-in method is not enabled in Firebase Authentication.';
    default:
      return error instanceof Error ? error.message : 'Authentication failed. Please try again.';
  }
}

export default function FirebaseAuthScreen() {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') await registerWithEmail(email.trim(), password);
      else await signInWithEmail(email.trim(), password);
    } catch (caught) {
      setError(friendlyAuthError(caught));
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (caught) {
      setError(friendlyAuthError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10 text-slate-900">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md items-center justify-center">
        <section className="w-full rounded-3xl bg-white p-8 shadow-2xl">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-lg">
              <LockKeyhole className="h-6 w-6" aria-hidden="true" />
            </div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">PipelineOS</p>
            <h1 className="mt-2 text-2xl font-bold text-slate-950">
              {mode === 'signin' ? 'Sign in to your workspace' : 'Create your workspace account'}
            </h1>
            <p className="mt-2 text-sm text-slate-500">
              Secure recruiting workflows for candidates, recruiters, and hiring teams.
            </p>
          </div>

          {error && (
            <div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={() => void google()}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
          >
            <Chrome className="h-4 w-4" aria-hidden="true" />
            Continue with Google
          </button>

          <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wider text-slate-400">
            <span className="h-px flex-1 bg-slate-200" />
            <span>or</span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>

          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <label className="block text-sm font-medium text-slate-700">
              <span className="mb-1.5 block">Email</span>
              <span className="relative block">
                <Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" aria-hidden="true" />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="w-full rounded-xl border border-slate-200 py-2.5 pl-10 pr-3 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  placeholder="you@example.com"
                />
              </span>
            </label>
            <label className="block text-sm font-medium text-slate-700">
              <span className="mb-1.5 block">Password</span>
              <input
                type="password"
                required
                minLength={6}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                placeholder="At least 6 characters"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60"
            >
              {mode === 'signin' ? <Mail className="h-4 w-4" aria-hidden="true" /> : <UserPlus className="h-4 w-4" aria-hidden="true" />}
              {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in with email' : 'Create account'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            {mode === 'signin' ? 'New to PipelineOS?' : 'Already have an account?'}{' '}
            <button
              type="button"
              onClick={() => { setMode(mode === 'signin' ? 'register' : 'signin'); setError(null); }}
              className="font-semibold text-blue-600 hover:text-blue-700"
            >
              {mode === 'signin' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        </section>
      </div>
    </main>
  );
}
