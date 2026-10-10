/**
 * The wire-golden capture tool (`scripts/capture-wire-goldens.ts`) is how a deliberate, reviewed wire
 * change is recorded. These tests keep it runnable on the installed effect: every entry the tool
 * wrote (an entry with its own `capturedWith` stamp) must be reproducible from the current schema,
 * and a merge must touch only the named entries so the rest of the frozen oracle stays as captured.
 *
 * The reproducibility check does not depend on the exact installed effect version. After an effect
 * bump it fails only when the sampler's output really changed for a stamped entry, and names the
 * entries to recapture with `--only` (see `AGENTS.md`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { Schema } from 'effect';

import {
  captureGolden,
  collectSchemas,
  goldensFile,
  installedEffect,
  mergeGoldens,
  SEED,
  serializeGoldens,
  type WireGolden,
  type WireGoldensFile,
} from '../scripts/wire-golden-capture.js';

const frozenText = readFileSync(goldensFile, 'utf8');
const frozen = JSON.parse(frozenText) as WireGoldensFile;

/** Entries the capture tool wrote: each carries the effect version it was captured with. */
const stamped = frozen.goldens.filter((golden) => golden.capturedWith !== undefined);

test('every golden the capture tool wrote is reproduced on the installed effect', () => {
  assert.ok(stamped.length > 0, 'no golden carries its own capturedWith stamp');
  const schemas = collectSchemas();
  const unresolved: string[] = [];
  const changed: string[] = [];
  for (const { capturedWith: _stamp, ...stored } of stamped) {
    const schema = schemas.get(stored.name);
    if (schema === undefined) {
      unresolved.push(stored.name);
    } else if (!isDeepStrictEqual(captureGolden(stored.name, schema), stored)) {
      changed.push(stored.name);
    }
  }
  assert.deepEqual(unresolved, [], `stamped goldens no longer resolve: ${unresolved.join(', ')}`);
  assert.deepEqual(
    changed,
    [],
    `sampler output changed on ${installedEffect()}; if no wire changed, recapture after the effect bump with --only ${changed.join(',')}`,
  );
});

test('merging the stored entries back reproduces the frozen file byte for byte', () => {
  // Merge each entry back with its own stamp, so the merge cannot restamp it with the installed effect.
  const byStamp = Map.groupBy(stamped, (golden) => golden.capturedWith ?? frozen.capturedWith);
  let merged = frozen;
  for (const [stamp, group] of byStamp) merged = mergeGoldens(merged, group, stamp);
  assert.equal(serializeGoldens(merged), frozenText);
});

test('a merge replaces only the named entries and keeps the file stamp', () => {
  const golden = (name: string, wire: unknown): WireGolden => ({
    name,
    samples: [{ wire, reencoded: wire }],
    probes: [],
  });
  const file: WireGoldensFile = {
    capturedWith: 'effect@3.21.2',
    seed: SEED,
    goldens: [golden('a', 1), golden('c', 3)],
  };

  const merged = mergeGoldens(file, [golden('c', 30), golden('b', 2)], 'effect@4.0.2');

  assert.deepEqual(merged, {
    capturedWith: 'effect@3.21.2',
    seed: SEED,
    goldens: [
      golden('a', 1),
      { ...golden('b', 2), capturedWith: 'effect@4.0.2' },
      { ...golden('c', 30), capturedWith: 'effect@4.0.2' },
    ],
  });
  // An entry captured with the file's own effect version needs no stamp of its own.
  assert.deepEqual(
    mergeGoldens(file, [golden('a', 10)], 'effect@3.21.2').goldens[0],
    golden('a', 10),
  );
});

test('a merge refuses a schema the sampler skipped and a file with another seed', () => {
  const file: WireGoldensFile = { capturedWith: 'effect@3.21.2', seed: SEED, goldens: [] };
  assert.throws(
    () =>
      mergeGoldens(
        file,
        [{ name: 'a', samples: [], probes: [], skipped: 'no arbitrary' }],
        'effect@4.0.2',
      ),
    /a could not be captured: no arbitrary/,
  );
  assert.throws(
    () => mergeGoldens({ ...file, seed: SEED + 1 }, [], 'effect@4.0.2'),
    /captured with seed/,
  );
});

test('a union golden samples every member, not only the smallest one', () => {
  const small = Schema.Struct({ code: Schema.Literal('small') });
  const large = Schema.Struct({
    code: Schema.Literal('large'),
    data: Schema.Struct({ reason: Schema.Literals(['one', 'two']), detail: Schema.String }),
  });

  const golden = captureGolden('union', Schema.Union([small, large]));

  assert.equal(golden.skipped, undefined);
  const codes = new Set(golden.samples.map((sample) => (sample.wire as { code: string }).code));
  assert.deepEqual([...codes].sort(), ['large', 'small']);
  // Determinism: the same schema always captures the same entry.
  assert.deepEqual(captureGolden('union', Schema.Union([small, large])), golden);
});
