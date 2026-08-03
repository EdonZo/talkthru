import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each test spawns the built server as a child process over stdio.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
