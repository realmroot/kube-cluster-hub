import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'control-plane/**/*.test.ts',
      'web/**/*.test.ts',
      'web/**/*.test.tsx',
    ],
    exclude: ['control-plane/**/*.worker.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 59,
        branches: 54,
        functions: 57,
        lines: 61,
      },
      include: ['control-plane/**/*.ts', 'web/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', 'control-plane/entry-*.ts'],
    },
  },
})
