/**
 * Single source of truth for the application name and version.
 *
 * The identity advertised over MCP (`MCP_SERVER_INFO`) and anywhere else that
 * needs the app version must not drift from `package.json`. This module reads
 * the package manifest once at load and exposes the resolved values.
 *
 * It is deliberately server-only and resolution is bundle-safe:
 *   - Under `tsx`/dev, `package.json` sits at the repository root.
 *   - Under the esbuild CJS bundle (`dist/server.cjs`), the manifest is copied
 *     alongside or one level up from the running file in the container image.
 * We probe a few candidate locations and fall back to a compiled-in constant so
 * a missing manifest never crashes startup.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Compiled-in fallback; kept in sync with package.json by the version tests. */
const FALLBACK = { name: 'pipelineos', version: '1.0.0' } as const;

function currentDir(): string {
  // Works under ESM (import.meta.url) and is rewritten to __dirname by esbuild
  // when the module is emitted as CJS, so both runtimes resolve a real path.
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

function readManifest(): { name: string; version: string } {
  const dir = currentDir();
  const candidates = [
    // dist/server.cjs -> ../package.json (image copies manifest next to dist)
    join(process.cwd(), 'package.json'),
    // src/server/version.ts -> ../../package.json (dev / tsx)
    join(dir, '..', '..', 'package.json'),
    join(dir, '..', 'package.json')
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (typeof parsed.name === 'string' && typeof parsed.version === 'string') {
        return { name: parsed.name, version: parsed.version };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { ...FALLBACK };
}

const manifest = readManifest();

/** The application name, sourced from package.json. */
export const APP_NAME = manifest.name;

/** The application version, sourced from package.json. */
export const APP_VERSION = manifest.version;
