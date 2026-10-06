import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { consoleJsonLogger } from './logging';
import { StartupError, startServer } from './server';

/** How long a shutdown may take before the process exits anyway. Cloud Run gives 10 seconds by default. */
const SHUTDOWN_TIMEOUT_MS = 9_000;

async function main(): Promise<void> {
  // Load .env from the working directory when present (Node 20.12+). Real environment variables win.
  const loadEnvFile = (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (existsSync('.env') && typeof loadEnvFile === 'function') loadEnvFile('.env');

  const logger = consoleJsonLogger;
  let server;
  try {
    server = await startServer(process.env, logger);
  } catch (err) {
    if (err instanceof StartupError) for (const problem of err.problems) logger.error({ msg: 'refusing to start', problem });
    else logger.error({ msg: 'failed to start', errorName: err instanceof Error ? err.name : 'unknown', detail: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  // Graceful shutdown: stop taking requests, finish the ones in flight, close the pool, exit 0.
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ msg: 'shutting down', signal });
    const timer = setTimeout(() => {
      logger.error({ msg: 'shutdown timed out' });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    server.close().then(
      () => {
        logger.info({ msg: 'shutdown complete' });
        process.exit(0);
      },
      () => {
        logger.error({ msg: 'shutdown failed' });
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

void main();
