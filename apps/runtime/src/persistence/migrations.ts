import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function migrationsDirectory() {
  const candidates = [
    fileURLToPath(new URL('./drizzle', import.meta.url)),
    fileURLToPath(new URL('../../drizzle', import.meta.url)),
    fileURLToPath(new URL('../drizzle', import.meta.url)),
    resolve(process.cwd(), 'apps/runtime/drizzle'),
    resolve(process.cwd(), 'drizzle'),
  ];
  const directory = candidates.find((candidate) => existsSync(candidate));
  if (!directory) {
    throw new Error(
      `Runtime database migrations directory not found. Checked: ${candidates.join(', ')}`,
    );
  }
  return directory;
}
