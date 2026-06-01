import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tools/**/*.test.ts',
      'conformance/**/*.test.ts',
      'packages/**/*.test.ts',
      'services/**/*.test.ts',
    ],
    environment: 'node',
    reporters: 'default',
  },
});
