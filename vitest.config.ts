import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `vendor/` holds the two upstreams for reference and diffing; their suites
    // are not ours to run. `live-smoke`/`ckpt-compare` need a running sidecar.
    include: ['test/**/*.test.ts'],
    exclude: ['vendor/**', 'node_modules/**'],
  },
});
