import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The three layers stay separate:
 *   shared   packages/core   pure TypeScript: no framework, no app code
 *   backend  apps/api        NestJS; may use shared
 *   frontend apps/web        Next.js; may use only the browser-safe shared entry (@core/web)
 * plus apps/extension (browser-safe shared entry only) and career-agent (separate Python tool).
 */
const ROOT = path.resolve(__dirname, '../../..');

function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.next', 'out', 'test'].includes(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, exts));
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

function imports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => (m[1] ?? m[2] ?? m[3]) as string);
}

const rel = (f: string) => path.relative(ROOT, f);

describe('layer boundaries', () => {
  it('shared (packages/core) imports no framework and nothing from an app', () => {
    const bad: string[] = [];
    for (const f of files(path.join(ROOT, 'packages/core/src'), ['.ts'])) {
      for (const i of imports(f)) {
        const resolved = i.startsWith('.') ? path.resolve(path.dirname(f), i) : i;
        if (/^@nestjs|^next\b|^react\b|^pg$|^express/.test(i) || resolved.includes(`${path.sep}apps${path.sep}`)) bad.push(`${rel(f)} -> ${i}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('frontend (apps/web) uses only the browser-safe shared entry and never backend code', () => {
    const bad: string[] = [];
    for (const f of files(path.join(ROOT, 'apps/web/src'), ['.ts', '.tsx'])) {
      for (const i of imports(f)) {
        const resolved = i.startsWith('.') ? path.resolve(path.dirname(f), i) : i;
        const allowed = i === '@core/web' || i.startsWith('next') || i === 'react' || (i.startsWith('.') && resolved.startsWith(path.join(ROOT, 'apps/web/src')));
        if (!allowed) bad.push(`${rel(f)} -> ${i}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('backend (apps/api) never imports frontend or extension code', () => {
    const bad: string[] = [];
    for (const f of files(path.join(ROOT, 'apps/api/src'), ['.ts'])) {
      for (const i of imports(f)) {
        const resolved = i.startsWith('.') ? path.resolve(path.dirname(f), i) : i;
        if (resolved.includes(path.join('apps', 'web')) || resolved.includes(path.join('apps', 'extension')) || /^next\b|^react\b/.test(i)) bad.push(`${rel(f)} -> ${i}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the browser-safe shared entries import nothing that reaches Node or the network', () => {
    for (const entry of ['browser.ts', 'web.ts']) {
      const seen = new Set<string>();
      const walk = (file: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        for (const i of imports(file)) {
          expect(i.startsWith('.'), `${rel(file)} imports ${i}`).toBe(true);
          walk(path.resolve(path.dirname(file), i.endsWith('.ts') ? i : `${i}.ts`));
        }
      };
      walk(path.join(ROOT, 'packages/core/src', entry));
      expect([...seen].map(rel).some((f) => /llm|sources|usage|repository/.test(f))).toBe(false);
    }
  });
});
