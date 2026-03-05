import { defineConfig } from 'vitest/config.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
});
