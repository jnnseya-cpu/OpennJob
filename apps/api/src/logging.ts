import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter, LoggerService } from '@nestjs/common';

/**
 * Structured logging: one JSON object per line.
 *
 * THE RULE: nothing that could be CV text, passport content, a supporting statement, a
 * password or a token is ever logged. So the request log takes no request body, no
 * response body, no query string and no headers; and an unexpected error is logged by
 * its type and code only, because an error MESSAGE can quote the data that caused it.
 * apps/api/test/logging.test.ts holds this to account.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

const write = (level: string, fields: LogFields, stream: NodeJS.WritableStream): void => {
  stream.write(`${JSON.stringify({ level, time: new Date().toISOString(), ...fields })}\n`);
};

export const consoleJsonLogger: Logger = {
  info: (fields) => write('info', fields, process.stdout),
  warn: (fields) => write('warn', fields, process.stderr),
  error: (fields) => write('error', fields, process.stderr),
};

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Keeps every line in memory. For tests. */
export function memoryLogger(): Logger & { lines: (LogFields & { level: string })[] } {
  const lines: (LogFields & { level: string })[] = [];
  return {
    lines,
    info: (fields) => void lines.push({ level: 'info', ...fields }),
    warn: (fields) => void lines.push({ level: 'warn', ...fields }),
    error: (fields) => void lines.push({ level: 'error', ...fields }),
  };
}

interface Req {
  method: string;
  path?: string;
  url: string;
  ip?: string;
  opennjobUserId?: string;
  opennjobRequestId?: string;
}
interface Res {
  statusCode: number;
  on(event: 'finish', listener: () => void): void;
  setHeader(name: string, value: string): void;
}

/**
 * Express middleware: one line per request, written when the response is finished.
 * Fields: request id, method, path (no query string), status, duration, user id.
 * Nothing else. The user id is the opaque account id, never the email address.
 */
export function requestLogger(logger: Logger, newId: () => string, now: () => number = Date.now) {
  return (req: Req, res: Res, next: () => void): void => {
    const started = now();
    const requestId = newId();
    req.opennjobRequestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      logger.info({
        msg: 'request',
        requestId,
        method: req.method,
        path: (req.path ?? req.url).split('?')[0],
        status: res.statusCode,
        durationMs: now() - started,
        userId: req.opennjobUserId ?? null,
      });
    });
    next();
  };
}

/**
 * Replies exactly as Nest does by default, and logs an unexpected error by its type and
 * code only (see THE RULE above). Errors raised on purpose (HttpException) and errors
 * from the body parser (too large, malformed JSON) are client errors and are not logged
 * here: the request line already records their status.
 */
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Req>();
    const res = http.getResponse<{ headersSent: boolean; status(code: number): { json(body: unknown): void } }>();
    if (res.headersSent) return;

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      res.status(exception.getStatus()).json(typeof body === 'string' ? { statusCode: exception.getStatus(), message: body } : body);
      return;
    }
    const e = exception as { status?: unknown; statusCode?: unknown; expose?: unknown; name?: unknown; code?: unknown; type?: unknown } | null;
    const status = typeof e?.statusCode === 'number' ? e.statusCode : typeof e?.status === 'number' ? e.status : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      const message = status === 413 ? 'Request body is too large' : status === 400 ? 'Request body could not be read' : 'Request refused';
      res.status(status).json({ statusCode: status, message });
      return;
    }
    this.logger.error({
      msg: 'unhandled error',
      requestId: req.opennjobRequestId ?? null,
      errorName: typeof e?.name === 'string' ? e.name : 'unknown',
      errorCode: typeof e?.code === 'string' || typeof e?.code === 'number' ? e.code : null,
    });
    res.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}

/** Routes Nest's own start-up and framework messages through the same JSON logger. */
export function nestLogger(logger: Logger): LoggerService {
  const text = (message: unknown): string => (typeof message === 'string' ? message : message instanceof Error ? message.name : 'non-text message');
  return {
    log: () => undefined, // route-mapping chatter
    warn: (message: unknown) => logger.warn({ msg: text(message), source: 'nest' }),
    error: (message: unknown) => logger.error({ msg: text(message), source: 'nest' }),
  };
}
