import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // ffmpeg-backed tests decode a 60 s fixture; the default 5 s is far too low.
    testTimeout: 180_000,
    hookTimeout: 300_000,
    // Sessions write to a shared temp home per file; parallel files are fine,
    // parallel tests inside a file are not (the ingest daemon binds a port).
    fileParallelism: true,
    sequence: { concurrent: false },
  },
});
