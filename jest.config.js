// Two Jest projects:
//  - unit:        no external services (workflow tests use Temporal's in-process test server)
//  - integration: needs the docker-compose Postgres on localhost:5432
/** @type {import('jest').Config} */
const base = { preset: 'ts-jest', testEnvironment: 'node' };

module.exports = {
  projects: [
    {
      ...base,
      displayName: 'unit',
      testMatch: ['<rootDir>/test/**/*.test.ts'],
      testPathIgnorePatterns: ['\\.int\\.test\\.ts$'],
    },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/**/*.int.test.ts'],
      setupFiles: ['<rootDir>/test/integration.env.ts'],
    },
  ],
};
