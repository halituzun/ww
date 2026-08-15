import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['templates/**', 'dist/**', 'node_modules/**'],
  },
});
