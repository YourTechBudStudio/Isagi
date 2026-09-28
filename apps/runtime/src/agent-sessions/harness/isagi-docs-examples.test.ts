import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isagiDocsPackageFiles } from './isagi-docs.js';

test('generated skill TypeScript examples compile against the public SDK', () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-docs-examples-'));
  try {
    // Resolve through the runtime's installed dependencies, just as a consumer package would.
    symlinkSync(
      fileURLToPath(new URL('../../../node_modules', import.meta.url)),
      join(root, 'node_modules'),
      'dir',
    );
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['*.ts'],
      }),
    );
    const examples: string[] = [];
    for (const [path, source] of isagiDocsPackageFiles('/example/isagi')) {
      if (!path.endsWith('.md')) continue;
      let index = 0;
      for (const match of source.matchAll(/^```(?:ts|typescript)\r?\n([\s\S]*?)^```\s*$/gm)) {
        const name = `${path.replaceAll('/', '-').replace(/\.md$/, '')}-${++index}.ts`;
        examples.push(name);
        // Each fence is a separate module, so repeated example-local type names cannot collide.
        writeFileSync(join(root, name), `${match[1]}\nexport {};\n`);
      }
    }
    assert.ok(examples.length > 0, 'expected TypeScript examples in the generated skill');
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json'))),
        '--project',
        join(root, 'tsconfig.json'),
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      `Skill examples failed typechecking:\n${result.stdout}\n${result.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
