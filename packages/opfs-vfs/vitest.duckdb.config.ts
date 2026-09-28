import { configDefaults, defineConfig } from 'vitest/config';
import config from './vitest.config';

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ['src/__tests__/duckdb-adapter.test.ts'],
    exclude: configDefaults.exclude,
  },
});
