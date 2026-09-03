import { useState, type FormEvent } from 'react';
import AuthSectionThree, { type AuthSectionMode } from './ui/auth-section-3';
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
  const [mode, setMode] = useState<AuthSectionMode>('signin');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
