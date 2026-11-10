// Load test for the OpennJob API: many signed-in people reading their screens at once.
//
//   node scripts/load-test.mjs --url http://127.0.0.1:3000 --token <access token> [--users 50] [--seconds 60]
//   node scripts/load-test.mjs --url https://opennjob.com/api --token ...      (production: keep it short)
//
// Each virtual person requests, in turn, the screens the web app loads (health, account,
// applications, matches, notifications, agent status), as fast as the API answers. It never
// writes, never signs in (sign-in is rate-limited on purpose) and never calls the AI. Prints
// p50/p95/p99 latency per route, requests a second and the error rate; exits 1 when a target is
// missed. Targets (pilot, one VPS): p95 under 800 ms, errors under 1%.
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const URL_BASE = (args.url ?? process.env.LOAD_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = args.token ?? process.env.LOAD_TOKEN ?? '';
const USERS = Number(args.users ?? 50);
const SECONDS = Number(args.seconds ?? 60);
const P95_TARGET_MS = Number(args['p95-ms'] ?? 800);
const ERROR_TARGET = Number(args['max-error-rate'] ?? 0.01);
if (!TOKEN) {
  console.error('load-test: --token is required (an access token of a test account).');
  process.exit(2);
}
const ROUTES = ['/health', '/account', '/applications', '/jobs/matches', '/notifications', '/agent/status'];

const stats = new Map(ROUTES.map((r) => [r, { ms: [], errors: 0, statuses: {} }]));
const until = Date.now() + SECONDS * 1000;

async function person(n) {
  let i = n;
  while (Date.now() < until) {
    const route = ROUTES[i++ % ROUTES.length];
    const s = stats.get(route);
    const t = performance.now();
    try {
      const res = await fetch(URL_BASE + route, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(15_000) });
      await res.arrayBuffer();
      s.statuses[res.status] = (s.statuses[res.status] ?? 0) + 1;
      if (res.status >= 400) s.errors += 1;
    } catch {
      s.errors += 1;
      s.statuses.network = (s.statuses.network ?? 0) + 1;
    }
    s.ms.push(performance.now() - t);
  }
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const started = Date.now();
await Promise.all(Array.from({ length: USERS }, (_, n) => person(n)));
const elapsed = (Date.now() - started) / 1000;

let total = 0;
let errors = 0;
const all = [];
console.log(`${USERS} people for ${SECONDS}s against ${URL_BASE}`);
console.log(`${'route'.padEnd(18)} ${'requests'.padStart(9)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)}  statuses`);
for (const [route, s] of stats) {
  const sorted = [...s.ms].sort((a, b) => a - b);
  total += sorted.length;
  errors += s.errors;
  all.push(...sorted);
  console.log(`${route.padEnd(18)} ${String(sorted.length).padStart(9)} ${pct(sorted, 50).toFixed(0).padStart(5)}ms ${pct(sorted, 95).toFixed(0).padStart(5)}ms ${pct(sorted, 99).toFixed(0).padStart(5)}ms  ${JSON.stringify(s.statuses)}`);
}
all.sort((a, b) => a - b);
const p95 = pct(all, 95);
const rate = total ? errors / total : 1;
console.log(`all: ${total} requests, ${(total / elapsed).toFixed(0)}/s, p50 ${pct(all, 50).toFixed(0)}ms, p95 ${p95.toFixed(0)}ms, p99 ${pct(all, 99).toFixed(0)}ms, errors ${(rate * 100).toFixed(2)}%`);
const ok = p95 <= P95_TARGET_MS && rate <= ERROR_TARGET;
console.log(ok ? `PASS (p95 <= ${P95_TARGET_MS}ms, errors <= ${ERROR_TARGET * 100}%)` : `FAIL (targets: p95 <= ${P95_TARGET_MS}ms, errors <= ${ERROR_TARGET * 100}%)`);
process.exit(ok ? 0 : 1);
