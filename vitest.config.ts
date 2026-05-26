import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    coverage: {
      reporter: ['text', 'lcov']
    },
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts']
  }
});
