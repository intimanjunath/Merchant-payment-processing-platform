import pino, {
  type Bindings,
  type ChildLoggerOptions,
  type DestinationStream,
  type Logger,
} from 'pino';

import { getContext } from './context';
import { redact } from './redact';

export type { Logger } from 'pino';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  /** Where lines go. Defaults to stdout; tests pass an in-memory stream. */
  destination?: DestinationStream;
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * JSON logger: one object per line with time, level, service, the current
 * request/job context, and the caller's fields with secrets redacted.
 */
export function createLogger(options: LoggerOptions): Logger {
  const logger = pino(
    {
      level: options.level ?? 'info',
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => redact(object) as Record<string, unknown>,
      },
      // The log formatter above runs first and already serializes errors (under any
      // key) with pino's standard serializer. Running it again on the plain object
      // would relabel the error's type as "Object".
      serializers: { err: (value: unknown) => value },
      mixin: () => ({ ...getContext() }),
    },
    options.destination,
  );
  return redactBindings(logger);
}

// pino types child() as generic over custom log levels, which this project
// doesn't use. This is the plain shape of the same method.
type ChildFn = (this: Logger, bindings: Bindings, options?: ChildLoggerOptions) => Logger;

/**
 * Fields bound with child() or setBindings() never pass through formatters.log,
 * and pino resets formatters.bindings to a pass-through for every child. So they
 * are redacted on the way in instead. Children are created with
 * Object.create(parent), so every descendant inherits these overrides.
 */
function redactBindings(logger: Logger): Logger {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- re-invoked below with the caller's `this`
  const child = logger.child as unknown as ChildFn;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- re-invoked below with the caller's `this`
  const setBindings = logger.setBindings;
  logger.child = function (this: Logger, bindings: Bindings, childOptions?: ChildLoggerOptions) {
    return child.call(this, redact(bindings) as Bindings, childOptions);
  } as unknown as Logger['child'];
  logger.setBindings = function (this: Logger, bindings) {
    setBindings.call(this, redact(bindings) as Bindings);
  };
  return logger;
}
