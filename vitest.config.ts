import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tools/**/*.test.ts',
      'conformance/**/*.test.ts',
      'packages/**/*.test.ts',
      'services/**/*.test.ts',
      'infra/**/*.test.ts',
    ],
    environment: 'node',
    reporters: 'default',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'services/*/src/**/*.ts', 'infra/*/src/**/*.ts'],
      exclude: [
        '**/index.ts', // barrels / service entrypoints (run main(); not unit-tested)
        '**/types.ts',
        // Live-IO adapters exercised only against the compose stack:
        'services/cdc-collector/src/bus.ts',
        'services/cdc-collector/src/source-stream.ts',
        'services/cdc-collector/src/offset-store.ts',
        'services/cdc-collector/src/attestation/mysql-sql-reader.ts',
        'services/cdc-collector/src/attestation/sql-config-reader.ts',
        'infra/dlq/src/store.ts', // PgDlqStore live path (InMemory covered)
      ],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
      },
    },
  },
});
