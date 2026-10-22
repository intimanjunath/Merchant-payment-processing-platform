import { isLogLevel, type LogLevel } from '@payments/observability';

export type Env = Record<string, string | undefined>;

const MIN_SECRET_BYTES = 32;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Reads typed settings from the environment, collecting every problem instead
 * of stopping at the first, so one start-up attempt shows them all. Messages
 * name variables but never echo their values.
 */
export class EnvReader {
  constructor(
    private readonly env: Env,
    private readonly problems: string[],
  ) {}

  string(name: string, fallback?: string): string {
    const value = this.env[name]?.trim();
    if (value) return value;
    if (fallback !== undefined) return fallback;
    this.problems.push(`${name} is required`);
    return '';
  }

  url(name: string): string {
    const value = this.string(name);
    if (value && !URL.canParse(value)) {
      this.problems.push(`${name} must be a valid URL`);
    }
    return value;
  }

  secret(name: string): string {
    const value = this.string(name);
    if (value && Buffer.byteLength(value) < MIN_SECRET_BYTES) {
      this.problems.push(`${name} must be at least ${String(MIN_SECRET_BYTES)} bytes`);
    }
    return value;
  }

  integer(name: string, rule: { fallback: number; min?: number; max?: number }): number {
    const raw = this.env[name]?.trim();
    if (!raw) return rule.fallback;
    const value = Number(raw);
    const tooSmall = rule.min !== undefined && value < rule.min;
    const tooLarge = rule.max !== undefined && value > rule.max;
    if (!Number.isInteger(value) || tooSmall || tooLarge) {
      const range =
        rule.max === undefined
          ? `>= ${String(rule.min)}`
          : `${String(rule.min)}-${String(rule.max)}`;
      this.problems.push(`${name} must be an integer ${range}`);
      return rule.fallback;
    }
    return value;
  }

  boolean(name: string, fallback: boolean): boolean {
    const raw = this.env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    this.problems.push(`${name} must be true or false`);
    return fallback;
  }

  list(name: string, fallback: string[]): string[] {
    const raw = this.env[name]?.trim();
    if (!raw) return fallback;
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  logLevel(name: string, fallback: LogLevel): LogLevel {
    const raw = this.env[name]?.trim();
    if (!raw) return fallback;
    if (isLogLevel(raw)) return raw;
    this.problems.push(`${name} must be one of fatal, error, warn, info, debug, trace, silent`);
    return fallback;
  }
}
