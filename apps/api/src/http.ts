import { randomUUID } from 'node:crypto';
import { CV_MAX_BYTES, CV_TYPES } from './cv';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { OpennJobConfig, OpennJobDeps } from './deps';
import { nestLogger, requestLogger } from './logging';

/**
 * The OpennJob extension's own origin. Its ID is fixed by the public key in
 * apps/extension/manifest.json, so it is the same on every computer it is loaded on.
 * The API takes bearer tokens, not cookies, so allowing it exposes nothing without a token.
 */
export const OPENNJOB_EXTENSION_ORIGIN = 'chrome-extension://hempmcajfhphflmemhidmgbfookifiim';

/** Is this browser origin allowed to call the API? Requests with no Origin (curl, server to server) are not CORS requests. */
export function originAllowed(origin: string | undefined, config: Pick<OpennJobConfig, 'corsOrigins' | 'corsAllowAnyExtension'>): boolean {
  if (!origin) return true;
  if (origin === OPENNJOB_EXTENSION_ORIGIN) return true;
  if (config.corsOrigins.includes(origin.replace(/\/+$/, ''))) return true;
  return config.corsAllowAnyExtension && origin.startsWith('chrome-extension://');
}

/**
 * Builds the HTTP application exactly as production runs it: security headers, the
 * CORS allow-list, the body size limit, the request log and the error filter. Tests
 * use this same function, so what they exercise is what is deployed.
 */
export async function createApp(deps: OpennJobDeps, options: { trustProxy?: string } = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(deps), { logger: nestLogger(deps.logger), bodyParser: false });

  // Behind a load balancer (Cloud Run) the client address is in X-Forwarded-For. Only
  // trust it when told to: otherwise anyone can forge an address and dodge the rate limit.
  if (options.trustProxy) app.set('trust proxy', /^\d+$/.test(options.trustProxy) ? Number(options.trustProxy) : options.trustProxy);
  app.disable('x-powered-by');

  app.use(requestLogger(deps.logger, randomUUID));
  // This API serves JSON only, so the strictest content policy costs nothing.
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => callback(null, originAllowed(origin, deps.config)),
    allowedHeaders: ['Authorization', 'Content-Type'],
    methods: ['GET', 'PUT', 'POST', 'DELETE'],
    maxAge: 600,
  });
  app.useBodyParser('json', { limit: deps.config.bodyLimit });
  // CV upload (PRO-1) is the one route that takes a file: a raw PDF or Word body, at most 5 MB.
  app.useBodyParser('raw', { limit: CV_MAX_BYTES, type: [CV_TYPES.pdf, CV_TYPES.docx] });
  // Responses carry personal data: never let a shared cache keep one.
  app.use((_req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  return app;
}
