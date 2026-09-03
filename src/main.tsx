import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import FirebaseAuthScreen from './components/FirebaseAuthScreen';
import PipelineLogo from './components/PipelineLogo';
import {
  establishServerSession,
  firebaseAuthenticationConfigured,
  observeFirebaseUser,
  signOutEverywhere,
  type FirebaseSession
} from './client/firebaseAuth';
import { applicationBootstrap } from './client/bootstrap';
import { PipelineError } from './shared/errors';
import './index.css';

type AuthState =
  | { status: 'loading'; error?: undefined }
  | { status: 'signed_out'; error?: string }
  | { status: 'signed_in'; session: FirebaseSession; error?: undefined }
  | { status: 'error'; error: string };

function LoadingScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
      <div className="text-center">
        <PipelineLogo tone="dark" className="pipeline-logo--centered" />
        <div className="mx-auto mb-4 mt-8 h-10 w-10 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        <p className="text-sm text-white/80">Preparing your secure workspace…</p>
      </div>
    </main>
  );
}

function BootstrappedApp({ session, onSignOut }: { session: FirebaseSession; onSignOut: () => Promise<void> }) {
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    const lifecycle = applicationBootstrap.acquire();
    let mounted = true;
    void lifecycle.ready.catch((error) => {
      if (mounted) setBootError(PipelineError.from(error).message);
    });
    return () => {
      mounted = false;
      lifecycle.release();
    };
  }, []);

  return <App bootError={bootError} session={session} onSignOut={onSignOut} />;
}

function AuthenticatedApplication({ session, onSignedOut }: { session: FirebaseSession; onSignedOut: () => void }) {
  const signOut = async () => {
    await signOutEverywhere();
    onSignedOut();
  };
  return <BootstrappedApp session={session} onSignOut={signOut} />;
}

function AuthenticatedRoot() {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    if (!firebaseAuthenticationConfigured()) {
      if (import.meta.env.DEV) {
        setState({
          status: 'signed_in',
          session: {
            authenticated: true,
            subject: 'sarah-recruiter',
            tenantId: 'pipelineos-demo',
            roles: ['recruiter'],
            email: 'demo@pipelineos.local'
          }
        });
        return undefined;
      }
      setState({
        status: 'error',
        error: 'Firebase Authentication is not configured for this deployment. Add the VITE_FIREBASE_* settings in Render and redeploy.'
      });
      return undefined;
    }

    let active = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = observeFirebaseUser(
        (user) => {
          if (!user) {
            if (active) setState({ status: 'signed_out' });
            return;
          }
          setState({ status: 'loading' });
          void establishServerSession(user)
            .then((session) => {
              if (active) setState({ status: 'signed_in', session });
            })
            .catch((error: unknown) => {
              if (active) setState({ status: 'error', error: PipelineError.from(error).message });
            });
        },
        (error) => {
          if (active) setState({ status: 'error', error: error.message });
        }
      );
    } catch (error) {
      setState({ status: 'error', error: PipelineError.from(error).message });
    }

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  if (state.status === 'loading') return <LoadingScreen />;
  if (state.status === 'signed_in') {
    return <AuthenticatedApplication session={state.session} onSignedOut={() => setState({ status: 'signed_out' })} />;
  }
  if (state.status === 'error') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-white">
        <div className="max-w-lg rounded-2xl bg-white p-6 text-slate-900 shadow-2xl">
          <PipelineLogo tone="light" />
          <h1 className="mt-6 text-xl font-bold">Authentication setup required</h1>
          <p className="mt-3 text-sm text-slate-600">{state.error}</p>
          <p className="mt-3 text-sm text-slate-600">
            Enable Email/Password and Google in Firebase Authentication, configure the Firebase web settings in Render, and redeploy the service.
          </p>
        </div>
      </main>
    );
  }
  return <FirebaseAuthScreen />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthenticatedRoot />
  </StrictMode>,
);
