/**
 * Firestore Admin SDK bootstrap for durable server persistence.
 *
 * The server is the authoritative writer of Shared_State, the idempotency
 * ledger, and web sessions. Those must survive a process restart and be shared
 * across instances, so they are backed by Cloud Firestore through the Firebase
 * Admin SDK (a service account), NOT the browser/web Firebase config.
 *
 * Credential resolution (first match wins):
 *   1. `FIREBASE_SERVICE_ACCOUNT`      - inline JSON of a service-account key.
 *   2. `GOOGLE_APPLICATION_CREDENTIALS`- path to a service-account key file
 *      (picked up automatically by `applicationDefault()`).
 *   3. Application Default Credentials  - e.g. the metadata server on Cloud
 *      Run / GCE, which is the recommended production path (no key files).
 *
 * The project id defaults to the PipelineOS project but can be overridden with
 * `FIREBASE_PROJECT_ID` / `GOOGLE_CLOUD_PROJECT`.
 *
 * Everything here is lazy and fail-soft at import time: importing this module
 * never touches the network. `getFirestore()` initializes on first use and
 * throws a clear error if no credentials are available, so a composition root
 * can decide whether persistence is required or optional.
 */

import { readFileSync } from 'node:fs';
import {
  cert,
  applicationDefault,
  getApps,
  initializeApp,
  type App,
  type ServiceAccount
} from 'firebase-admin/app';
import {
  getFirestore as getAdminFirestore,
  type Firestore
} from 'firebase-admin/firestore';

/** Default Firestore project for PipelineOS. */
export const DEFAULT_FIREBASE_PROJECT_ID = 'pipelineos-d8a4e';

/** Name of the Firebase app used exclusively for server persistence. */
const APP_NAME = 'pipelineos-persistence';

export interface FirestoreBootstrapOptions {
  /** Firestore project id. Defaults to env or the PipelineOS project. */
  projectId?: string;
  /** Inline service-account JSON (overrides env). */
  serviceAccount?: ServiceAccount | string;
  /** Path to a service-account key file (overrides env). */
  credentialsPath?: string;
}

function resolveProjectId(options: FirestoreBootstrapOptions): string {
  return (
    options.projectId ??
    process.env.FIREBASE_PROJECT_ID ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    DEFAULT_FIREBASE_PROJECT_ID
  );
}

function parseServiceAccount(value: ServiceAccount | string): ServiceAccount {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  // Accept either inline JSON or a path to a JSON key file.
  const json = trimmed.startsWith('{')
    ? trimmed
    : readFileSync(trimmed, 'utf8');
  return JSON.parse(json) as ServiceAccount;
}

function resolveServiceAccount(
  options: FirestoreBootstrapOptions
): ServiceAccount | undefined {
  if (options.serviceAccount !== undefined) {
    return parseServiceAccount(options.serviceAccount);
  }
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline !== undefined && inline.trim().length > 0) {
    return parseServiceAccount(inline);
  }
  const path = options.credentialsPath;
  if (path !== undefined && path.trim().length > 0) {
    return parseServiceAccount(path);
  }
  return undefined;
}

let cachedApp: App | undefined;
let cachedFirestore: Firestore | undefined;

/**
 * Initialize (once) and return the Admin `App` used for persistence. Reuses an
 * existing app of the same name so hot-reload in development does not throw.
 */
export function getPersistenceApp(
  options: FirestoreBootstrapOptions = {}
): App {
  if (cachedApp !== undefined) return cachedApp;

  const existing = getApps().find((app) => app?.name === APP_NAME);
  if (existing) {
    cachedApp = existing;
    return existing;
  }

  const projectId = resolveProjectId(options);
  const serviceAccount = resolveServiceAccount(options);
  const credential =
    serviceAccount !== undefined ? cert(serviceAccount) : applicationDefault();

  cachedApp = initializeApp(
    {
      credential,
      projectId
    },
    APP_NAME
  );
  return cachedApp;
}

/**
 * Return the shared Firestore instance for server persistence, initializing
 * the Admin app on first use. Throws if credentials cannot be resolved.
 */
export function getFirestore(
  options: FirestoreBootstrapOptions = {}
): Firestore {
  if (cachedFirestore !== undefined) return cachedFirestore;
  const app = getPersistenceApp(options);
  const firestore = getAdminFirestore(app);
  // ignoreUndefinedProperties keeps serialization forgiving: optional fields
  // in domain records that are `undefined` are simply omitted rather than
  // rejected by the Firestore client.
  try {
    firestore.settings({ ignoreUndefinedProperties: true });
  } catch {
    // settings() throws if called after first use; safe to ignore on reuse.
  }
  cachedFirestore = firestore;
  return firestore;
}

/**
 * True when Firestore persistence can be initialized (credentials are present
 * or ADC is available). This never throws; it is used by the composition root
 * to decide between durable and in-memory stores.
 */
export function firestoreCredentialsAvailable(
  options: FirestoreBootstrapOptions = {}
): boolean {
  if (resolveServiceAccount(options) !== undefined) return true;
  if (
    process.env.GOOGLE_APPLICATION_CREDENTIALS !== undefined &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS.trim().length > 0
  ) {
    return true;
  }
  // Cloud Run / GCE metadata server provides ADC without explicit env vars.
  return (
    process.env.K_SERVICE !== undefined ||
    process.env.FUNCTION_TARGET !== undefined ||
    process.env.GCE_METADATA_HOST !== undefined
  );
}

/** Reset cached handles. Intended for tests only. */
export function resetPersistenceForTesting(): void {
  cachedApp = undefined;
  cachedFirestore = undefined;
}
