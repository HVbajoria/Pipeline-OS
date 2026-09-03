import { useEffect, useState, type FormEvent } from 'react';
import AuthSectionThree, { type AuthSectionMode } from './ui/auth-section-3';
import {
  registerWithEmail,
  signInWithEmail,
  signInWithGoogle
} from '../client/firebaseAuth';

export function friendlyAuthError(error: unknown): string {
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
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'The Google sign-in window was closed before authentication completed.';
    case 'auth/unauthorized-domain':
      return 'This website is not authorized for Firebase Google sign-in. Add pipelineos-lkol.onrender.com under Firebase Authentication → Settings → Authorized domains.';
    case 'auth/invalid-api-key':
      return 'The Firebase web configuration is invalid. Check the Render VITE_FIREBASE_* values.';
    case 'auth/internal-error':
      return 'Google sign-in was blocked by browser security settings or an incomplete Firebase configuration. Check the authorized domain and try again in a private window.';
    case 'auth/operation-not-allowed':
      return 'This sign-in method is not enabled in Firebase Authentication.';
    default:
      return error instanceof Error ? error.message : 'Authentication failed. Please try again.';
  }
}

interface FirebaseAuthScreenProps {
  initialError?: string;
}

export default function FirebaseAuthScreen({ initialError }: FirebaseAuthScreenProps = {}) {
  const [mode, setMode] = useState<AuthSectionMode>('signin');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  useEffect(() => {
    if (initialError !== undefined) setError(initialError);
  }, [initialError]);

  const changeMode = (nextMode: AuthSectionMode) => {
    setMode(nextMode);
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        const displayName = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ');
        await registerWithEmail(email.trim(), password, displayName);
      } else {
        await signInWithEmail(email.trim(), password);
      }
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
    <AuthSectionThree
      mode={mode}
      firstName={firstName}
      lastName={lastName}
      email={email}
      password={password}
      busy={busy}
      error={error}
      onModeChange={changeMode}
      onFirstNameChange={setFirstName}
      onLastNameChange={setLastName}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onSubmit={(event) => void submit(event)}
      onGoogleSignIn={() => void google()}
    />
  );
}
