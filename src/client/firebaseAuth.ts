import {
  getApps,
  initializeApp,
  type FirebaseApp
} from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
  type Auth,
  type User,
  type Unsubscribe
} from 'firebase/auth';

export interface FirebaseSession {
  authenticated: true;
  subject: string;
  tenantId: string;
  roles: readonly string[];
  email?: string;
}

interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
}

function envValue(name: string): string | undefined {
  const value = import.meta.env[name] as string | undefined;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function runtimeValue(name: keyof FirebaseConfig): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = window.__PIPELINEOS_FIREBASE_CONFIG__?.[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function configValue(
  environmentName: string,
  runtimeName: keyof FirebaseConfig
): string | undefined {
  return envValue(environmentName) ?? runtimeValue(runtimeName);
}

function firebaseConfig(): FirebaseConfig {
  const apiKey = configValue('VITE_FIREBASE_API_KEY', 'apiKey');
  const authDomain = configValue('VITE_FIREBASE_AUTH_DOMAIN', 'authDomain');
  const projectId = configValue('VITE_FIREBASE_PROJECT_ID', 'projectId');
  const appId = configValue('VITE_FIREBASE_APP_ID', 'appId');
  if (apiKey === undefined || authDomain === undefined || projectId === undefined || appId === undefined) {
    throw new Error(
      'Firebase Authentication is not configured. Set the VITE_FIREBASE_* values on the server or expose the public settings through /config.js.'
    );
  }
  const storageBucket = configValue('VITE_FIREBASE_STORAGE_BUCKET', 'storageBucket');
  const messagingSenderId = configValue(
    'VITE_FIREBASE_MESSAGING_SENDER_ID',
    'messagingSenderId'
  );
  return {
    apiKey,
    authDomain,
    projectId,
    appId,
    ...(storageBucket === undefined ? {} : { storageBucket }),
    ...(messagingSenderId === undefined ? {} : { messagingSenderId })
  };
}

let app: FirebaseApp | undefined;
let auth: Auth | undefined;

export function firebaseAuthenticationConfigured(): boolean {
  return (
    configValue('VITE_FIREBASE_API_KEY', 'apiKey') !== undefined &&
    configValue('VITE_FIREBASE_AUTH_DOMAIN', 'authDomain') !== undefined &&
    configValue('VITE_FIREBASE_PROJECT_ID', 'projectId') !== undefined &&
    configValue('VITE_FIREBASE_APP_ID', 'appId') !== undefined
  );
}

export function firebaseAuth(): Auth {
  if (auth !== undefined) return auth;
  app = app ?? getApps().find((entry) => entry.name === 'pipelineos-client') ?? initializeApp(firebaseConfig(), 'pipelineos-client');
  auth = getAuth(app);
  return auth;
}

export function observeFirebaseUser(
  callback: (user: User | null) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const currentAuth = firebaseAuth();
  let notifiedUid: string | null | undefined;
  const notify = (user: User | null) => {
    const uid = user?.uid ?? null;
    if (notifiedUid === uid) return;
    notifiedUid = uid;
    callback(user);
  };

  const unsubscribe = onAuthStateChanged(currentAuth, notify, (error) => {
    onError?.(error instanceof Error ? error : new Error('Firebase authentication failed'));
  });

  return unsubscribe;
}

export function signInWithEmail(email: string, password: string): Promise<User> {
  return signInWithEmailAndPassword(firebaseAuth(), email, password).then(
    (credential) => credential.user
  );
}

export async function registerWithEmail(
  email: string,
  password: string,
  displayName?: string
): Promise<User> {
  const credential = await createUserWithEmailAndPassword(firebaseAuth(), email, password);
  const name = displayName?.trim();
  if (name !== undefined && name.length > 0) {
    await updateProfile(credential.user, { displayName: name });
  }
  return credential.user;
}

function parseResponseBody(response: Response): Promise<unknown> {
  return response.text().then((text) => {
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  });
}

function errorFromResponse(body: unknown, fallback: string): Error {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const value = (body as { error?: unknown }).error;
    if (typeof value === 'string') return new Error(value);
  }
  return new Error(fallback);
}

export async function establishServerSession(user: User): Promise<FirebaseSession> {
  const token = await user.getIdToken();
  const response = await fetch('/auth/firebase/session', {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`
    }
  });
  const body = await parseResponseBody(response);
  if (!response.ok || typeof body !== 'object' || body === null || !('authenticated' in body)) {
    throw errorFromResponse(body, 'The server could not establish an authenticated session');
  }
  return body as FirebaseSession;
}

export async function loadServerSession(): Promise<FirebaseSession | null> {
  const response = await fetch('/auth/session', {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' }
  });
  const body = await parseResponseBody(response);
  if (!response.ok) throw errorFromResponse(body, 'The server session could not be loaded');
  if (
    typeof body !== 'object' ||
    body === null ||
    (body as { authenticated?: unknown }).authenticated !== true
  ) {
    return null;
  }
  return body as FirebaseSession;
}

export async function signOutEverywhere(): Promise<void> {
  await fetch('/auth/logout', {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json' }
  });
  await signOut(firebaseAuth());
}
