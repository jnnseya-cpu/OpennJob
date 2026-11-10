// After `next build`: give every exported page a Content-Security-Policy <meta> that allows only
// its own inline scripts, by SHA-256 hash. Next.js inlines its bootstrap scripts, so without this
// the site's policy had to allow every inline script ('unsafe-inline'), and an injected script
// could read the kept sign-in. Browsers enforce both this policy and Caddy's header, so the
// stricter one wins; a page without the tag falls back to the header and still works.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = new URL('../out/', import.meta.url).pathname;
const INLINE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const MARK = '<meta charSet="utf-8"/>';

export function policyFor(html) {
  const hashes = new Set();
  for (const m of html.matchAll(INLINE)) {
    if (m[1]) hashes.add(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return `script-src 'self' ${[...hashes].join(' ')}`.trim() + "; object-src 'none'; base-uri 'self'";
}

function pages(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? pages(p) : p.endsWith('.html') ? [p] : [];
  });
}

let n = 0;
for (const file of pages(OUT)) {
  const html = readFileSync(file, 'utf8');
  if (html.includes('http-equiv="Content-Security-Policy"')) continue;
  if (!html.includes(MARK)) throw new Error(`csp: no charset tag in ${file}; cannot place the policy before the scripts`);
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policyFor(html)}"/>`;
  writeFileSync(file, html.replace(MARK, MARK + tag));
  n += 1;
}
console.log(`csp: policy added to ${n} pages`);
