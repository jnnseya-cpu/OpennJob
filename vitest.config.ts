import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against the TypeScript sources, so no build is needed before `npm test`.
      '@opennjob/core/browser': path.resolve(__dirname, 'packages/core/src/browser.ts'),
      '@opennjob/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/api/test/**/*.test.ts'],
    environment: 'node',
  },
});
