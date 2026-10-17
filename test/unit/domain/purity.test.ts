import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'node:path';

const DOMAIN_DIR = join(import.meta.dir, '../../../src/domain');
const ALLOWED_PACKAGES = new Set(['decimal.js']);

describe('src/domain is pure', () => {
  test('imports only relative modules and the allowed packages (no NestJS, ORM or node:)', async () => {
    const offenders: string[] = [];
    let files = 0;
    for await (const scanned of new Glob('**/*.ts').scan(DOMAIN_DIR)) {
      const path = scanned.replaceAll('\\', '/');
      files++;
      const source = await Bun.file(join(DOMAIN_DIR, path)).text();
      for (const match of source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] as string;
        if (!specifier.startsWith('.') && !ALLOWED_PACKAGES.has(specifier)) {
          offenders.push(`${path}: ${specifier}`);
        }
      }
    }
    expect(files).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test('relative imports never leave the domain folder', async () => {
    const offenders: string[] = [];
    for await (const scanned of new Glob('**/*.ts').scan(DOMAIN_DIR)) {
      const path = scanned.replaceAll('\\', '/');
      const source = await Bun.file(join(DOMAIN_DIR, path)).text();
      for (const match of source.matchAll(/from\s+['"](\.\.[^'"]*)['"]/g)) {
        const depth = (path.match(/\//g) ?? []).length;
        const ups = (match[1] as string).split('/').filter((p) => p === '..').length;
        if (ups > depth) offenders.push(`${path}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no floating point conversion on money (parseFloat, Number(), Number#toFixed)', async () => {
    const offenders: string[] = [];
    for await (const scanned of new Glob('**/*.ts').scan(DOMAIN_DIR)) {
      const path = scanned.replaceAll('\\', '/');
      const source = await Bun.file(join(DOMAIN_DIR, path)).text();
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/parseFloat|\bNumber\(|\.toNumber\(/.test(code)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
