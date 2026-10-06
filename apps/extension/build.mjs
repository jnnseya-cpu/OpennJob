// Bundles the extension into apps/extension/dist with esbuild.
// @opennjob/core/browser is bundled from source so the policy and field-classification
// code in the extension is the same code the unit tests cover.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: {
    content: path.join(here, 'src/content.ts'),
    background: path.join(here, 'src/background.ts'),
    popup: path.join(here, 'src/popup/popup.ts'),
  },
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  platform: 'browser',
  sourcemap: false,
  minify: false, // kept readable so the bundle can be reviewed
  legalComments: 'none',
  alias: { '@opennjob/core/browser': path.join(here, '../../packages/core/src/browser.ts') },
  logLevel: 'info',
});

for (const file of ['manifest.json', 'src/popup/popup.html', 'src/popup/popup.css']) {
  cpSync(path.join(here, file), path.join(dist, path.basename(file)));
}
console.log(`Extension built: ${dist}`);
