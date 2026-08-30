import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Single-run test configuration shared by pure domain, server, and client
 * module tests. The aliases mirror tsconfig.json so tests exercise the same
 * import paths as production code.
 */
export default defineConfig({
  root: rootDir,
  resolve: {
    alias: {
      '@': rootDir,
      '@shared': path.resolve(rootDir, 'src/shared'),
      '@server': path.resolve(rootDir, 'src/server'),
      '@client': path.resolve(rootDir, 'src/client')
    }
  },
  test: {
    environment: 'node',
    globals: true,
    include: [
      'test/**/*.test.ts',
      'test/**/*.test.tsx',
      'src/**/*.test.ts',
      'src/**/*.test.tsx'
    ],
    exclude: ['node_modules/**', 'dist/**'],
    passWithNoTests: true
  }
});
