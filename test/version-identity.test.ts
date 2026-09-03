import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { APP_NAME, APP_VERSION } from '../src/server/version';
import { MCP_SERVER_INFO } from '../src/server/mcp';

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    'utf8'
  )
) as { name: string; version: string };

describe('application identity is sourced from package.json', () => {
  it('exposes the package name and version through version.ts', () => {
    expect(APP_NAME).toBe(pkg.name);
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('advertises the same identity to MCP clients (no hardcoded drift)', () => {
    expect(MCP_SERVER_INFO.name).toBe(pkg.name);
    expect(MCP_SERVER_INFO.version).toBe(pkg.version);
  });

  it('uses a real package identity, not the scaffold defaults', () => {
    expect(pkg.name).toBe('pipelineos');
    expect(pkg.version).not.toBe('0.0.0');
  });
});
