import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** DIS-5: every job-source adapter has a row in docs/sources.md with its terms-check state. */
describe('DIS-5: the job-source terms register', () => {
  const root = join(__dirname, '..', '..', '..');
  const register = readFileSync(join(root, 'docs', 'sources.md'), 'utf8');
  const adapters = readdirSync(join(root, 'packages', 'core', 'src', 'sources'))
    .filter((f) => f.endsWith('.ts') && !['common.ts', 'dedupe.ts', 'index.ts'].includes(f))
    .map((f) => f.replace(/\.ts$/, ''));

  it('finds the adapters', () => {
    expect(adapters).toEqual(expect.arrayContaining(['greenhouse', 'lever', 'ashby', 'adzuna', 'reed', 'sample']));
  });

  for (const name of adapters) {
    it(`${name} has a row with a terms-check state`, () => {
      const row = register.split('\n').find((l) => l.startsWith(`| \`${name}\` |`));
      expect(row, `docs/sources.md has no row for ${name}`).toBeDefined();
      expect(row).toMatch(/\| (not checked|not needed|checked \d{4}-\d{2}-\d{2} by [^|]+) \|/);
    });
  }

  it('says plainly that no live source has been checked, while that is true', () => {
    const live = register.split('\n').filter((l) => /^\| `(greenhouse|lever|ashby|adzuna|reed|reliefweb|jooble)` \|/.test(l));
    if (live.every((l) => l.includes('| not checked |'))) expect(register).toContain('No source has had its terms checked.');
  });
});
