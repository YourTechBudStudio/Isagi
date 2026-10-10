/**
 * Records a deliberate, reviewed wire change in the frozen contract wire goldens
 * (`test/wire-goldens/wire-goldens.json`, checked by `src/wire-goldens.test.ts`).
 *
 * Usage (from the repo root):
 *
 *   pnpm -C packages/contracts exec tsx scripts/capture-wire-goldens.ts --only <name>[,<name>...]
 *     Recaptures only the named goldens (export names or `endpoint:<domain>.<key>.<part>`) and
 *     merges them into the frozen file. Every other entry and the file's `capturedWith` stamp are
 *     kept; a recaptured entry records its own `capturedWith`. Nothing is written when a name does
 *     not resolve or a schema cannot be sampled.
 *
 *   pnpm -C packages/contracts exec tsx scripts/capture-wire-goldens.ts [--out <file>]
 *     Captures every schema. Without `--out` it only compares the result with the frozen file and
 *     lists the entries that differ; it never overwrites the frozen file. With `--out` it writes the
 *     full capture to that file (for inspection; not the frozen file).
 *
 * Most frozen entries were captured with effect@3.21.2, whose sample generator differs from v4's,
 * so a full v4 recapture differs from almost every entry. That is why recapture is per schema.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  captureAll,
  captureGolden,
  collectSchemas,
  goldensFile,
  installedEffect,
  mergeGoldens,
  serializeGoldens,
  type WireGolden,
  type WireGoldensFile,
} from './wire-golden-capture.js';

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const { values } = parseArgs({
  options: { only: { type: 'string' }, out: { type: 'string' } },
  strict: true,
});

const frozenPath = fileURLToPath(goldensFile);
const frozenText = readFileSync(frozenPath, 'utf8');
const frozen = JSON.parse(frozenText) as WireGoldensFile;
const frozenByName = new Map(frozen.goldens.map((golden) => [golden.name, golden]));
const summary = (golden: WireGolden | undefined): string =>
  golden === undefined
    ? 'absent'
    : `${golden.samples.length} samples, ${golden.probes.length} probes${golden.capturedWith ? `, ${golden.capturedWith}` : ''}`;

if (values.only !== undefined) {
  if (values.out !== undefined) fail('--only always writes the frozen file; drop --out');
  const names = [
    ...new Set(
      values.only
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  if (names.length === 0) fail('--only needs at least one golden name');
  const schemas = collectSchemas();
  const unknown = names.filter((name) => !schemas.has(name));
  if (unknown.length > 0) {
    fail(
      `not a captured schema: ${unknown.join(', ')}. A schema that no longer exists goes in test/wire-goldens/renames.json or removed.json.`,
    );
  }
  // The same schema object is often captured under several names (an export and the endpoint
  // parts that use it); recapturing only some of them leaves the others on the old samples.
  const aliases = [...schemas]
    .filter(
      ([name, schema]) => !names.includes(name) && names.some((n) => schemas.get(n) === schema),
    )
    .map(([name]) => name);
  if (aliases.length > 0) {
    console.log(`note: the same schema is also captured as ${aliases.join(', ')}`);
  }
  const recaptured = names.map((name) => captureGolden(name, schemas.get(name)!));
  let merged: WireGoldensFile;
  try {
    merged = mergeGoldens(frozen, recaptured, installedEffect());
  } catch (error) {
    merged = fail(`nothing written: ${error instanceof Error ? error.message : String(error)}`);
  }
  const mergedByName = new Map(merged.goldens.map((golden) => [golden.name, golden]));
  for (const name of names) {
    const before = frozenByName.get(name);
    const after = mergedByName.get(name);
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    console.log(`${name}: ${unchanged ? 'unchanged' : `${summary(before)} -> ${summary(after)}`}`);
  }
  const text = serializeGoldens(merged);
  if (text === frozenText) {
    console.log('wire-goldens.json is unchanged');
  } else {
    writeFileSync(frozenPath, text);
    console.log(`wrote ${frozenPath}`);
  }
} else {
  const full = captureAll();
  const skipped = full.goldens.filter((golden) => golden.skipped !== undefined);
  const sampleCount = full.goldens.reduce((n, golden) => n + golden.samples.length, 0);
  const probeCount = full.goldens.reduce((n, golden) => n + golden.probes.length, 0);
  console.log(
    `${full.capturedWith}: schemas=${full.goldens.length} samples=${sampleCount} probes=${probeCount} skipped=${skipped.length}`,
  );
  for (const golden of skipped) console.log(`  skipped ${golden.name}: ${golden.skipped}`);
  if (values.out !== undefined) {
    const outPath = resolve(process.cwd(), values.out);
    if (outPath === frozenPath) fail('--out must not be the frozen file; use --only <name,...>');
    writeFileSync(outPath, serializeGoldens(full));
    console.log(`wrote ${outPath}`);
  } else {
    const capturedByName = new Map(full.goldens.map((golden) => [golden.name, golden]));
    const names = [...new Set([...frozenByName.keys(), ...capturedByName.keys()])].sort();
    const differing = names.filter((name) => {
      const before = frozenByName.get(name);
      const after = capturedByName.get(name);
      if (before === undefined || after === undefined) return true;
      const { capturedWith: _stamp, ...stored } = before;
      return JSON.stringify(stored) !== JSON.stringify(after);
    });
    if (differing.length === 0) {
      console.log('every frozen golden is reproduced byte-identically');
    } else {
      console.log(
        `${differing.length} of ${names.length} goldens differ from a recapture (frozen file not written):`,
      );
      for (const name of differing) {
        console.log(
          `  ${name}: frozen ${summary(frozenByName.get(name))}; recapture ${summary(capturedByName.get(name))}`,
        );
      }
      console.log(
        'Recapture only deliberately changed schemas with --only <name,...> after the wire change is reviewed.',
      );
    }
  }
}
