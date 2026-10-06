import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createDefaultDeps } from './deps';

async function bootstrap(): Promise<void> {
  // Load .env from the working directory when present (Node 20.12+). Real environment variables win.
  const loadEnvFile = (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (existsSync('.env') && typeof loadEnvFile === 'function') loadEnvFile('.env');

  const deps = createDefaultDeps(process.env);
  if (!deps.config.apiToken) {
    console.error('[opennjob] OPENNJOB_API_TOKEN is not set. Copy .env.example to .env and set a long random value.');
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule.register(deps));
  const extraOrigins = (process.env.OPENNJOB_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({
    // The extension calls the API from a chrome-extension:// origin. Requests still need the bearer token.
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) =>
      callback(null, !origin || origin.startsWith('chrome-extension://') || extraOrigins.includes(origin)),
    allowedHeaders: ['Authorization', 'Content-Type'],
    methods: ['GET', 'PUT', 'POST'],
  });

  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  console.log(`[opennjob] API listening on http://${host}:${port}`);
  console.log(`[opennjob] LLM: ${deps.llm ? 'Anthropic (configured)' : 'not configured - deterministic fallbacks in use'}`);
  console.log(`[opennjob] Job sources: ${deps.sources.length ? deps.sources.map((s) => s.label).join(', ') : 'none configured (set OPENNJOB_DEMO_JOBS=true to try the sample jobs)'}`);
  console.log('[opennjob] Persistence: in-memory. All data is lost when this process stops.');
}

void bootstrap();
