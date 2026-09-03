/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface PipelineOSFirebaseRuntimeConfig {
  readonly apiKey?: string;
  readonly authDomain?: string;
  readonly storageBucket?: string;
  readonly messagingSenderId?: string;
  readonly projectId?: string;
  readonly appId?: string;
}

interface Window {
  readonly __PIPELINEOS_FIREBASE_CONFIG__?: PipelineOSFirebaseRuntimeConfig;
}
