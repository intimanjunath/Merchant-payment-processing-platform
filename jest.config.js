/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/packages', '<rootDir>/apps', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // The dashboard's tests run under Vitest, with the browser-targeted build settings.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '<rootDir>/apps/web/'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tests/tsconfig.json' }],
  },
  // Tests run against package sources, so a stale dist/ can never hide a change.
  moduleNameMapper: {
    '^@payments/([^/]+)$': '<rootDir>/packages/$1/src',
  },
};
