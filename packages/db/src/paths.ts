import path from 'node:path';

// Compiled files live in dist/, so the SQL folders are one level up.
export const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
export const SEEDS_DIR = path.resolve(__dirname, '..', 'seeds');
