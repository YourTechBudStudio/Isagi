import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/*/tables.ts',
  out: './drizzle',
  dialect: 'sqlite',
  strict: true,
  verbose: true,
});
