import { useEffect, useState, type FormEvent } from 'react';
import AuthSectionThree, { type AuthSectionMode } from './ui/auth-section-3';
import { registerWithEmail, signInWithEmail } from '../client/firebaseAuth';

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
    case 'auth/invalid-api-key':
      return 'The Firebase web configuration is invalid. Check the Render VITE_FIREBASE_* values.';
    case 'auth/operation-not-allowed':
      return 'Email/password sign-in is not enabled in Firebase Authentication.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a moment and try again.';
    default:
      return error instanceof Error ? error.message : 'Authentication failed. Please try again.';
  }
}

interface FirebaseAuthScreenProps {
  mode: AuthSectionMode;
  initialError?: string;
}

export default function FirebaseAuthScreen({ mode, initialError }: FirebaseAuthScreenProps) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  useEffect(() => {
    setError(initialError ?? null);
  }, [initialError]);

  // Clear any lingering error when switching between sign-in and sign-up.
  useEffect(() => {
    setError(initialError ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

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

  return (
    <AuthSectionThree
      mode={mode}
      firstName={firstName}
      lastName={lastName}
      email={email}
      password={password}
      busy={busy}
      error={error}
      onFirstNameChange={setFirstName}
      onLastNameChange={setLastName}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onSubmit={(event) => void submit(event)}
    />
  );
}
