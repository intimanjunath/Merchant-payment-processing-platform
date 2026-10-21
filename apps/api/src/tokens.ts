// Injection tokens for values built outside Nest (in main.ts or a test) and handed in.
export const CONFIG = Symbol('CONFIG');
export const LOGGER = Symbol('LOGGER');
export const DB_POOL = Symbol('DB_POOL');
export const METRICS = Symbol('METRICS');
export const READINESS_TIMEOUT_MS = Symbol('READINESS_TIMEOUT_MS');
