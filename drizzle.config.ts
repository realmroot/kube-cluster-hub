import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './control-plane/schema.ts',
  out: './migrations',
})
