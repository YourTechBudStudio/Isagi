/**
 * Captures the contract wire goldens checked by `src/wire-goldens.test.ts`.
 *
 * For every Schema exported by `@isagi/contracts` and every schema part of every endpoint in
 * `apiEndpoints`, it stores a few small JSON wire samples, their re-encoded output, the schema's
 * `.literals`, and the accept/reject decision (plus re-encoded output) for deterministic adversarial
 * probes. The output is seeded, so two captures of the same contracts are byte-identical.
 *
 * Usage: `pnpm -C packages/contracts exec tsx scripts/capture-wire-goldens.ts`
 *
 * The goldens are a frozen oracle: only recapture when a wire change is deliberate and reviewed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Arbitrary, FastCheck, Schema } from 'effect';

import * as contracts from '../src/index.js';
import { applyMutation, mutationsOf, type Mutation } from '../src/testing/wire-golden-mutations.js';

const SEED = 20261009;
const SAMPLES = 3;
const CANDIDATES = 40;
const MAX_SAMPLE_BYTES = 2_000;
const ENDPOINT_PARTS = [
  'params',
  'query',
  'body',
  'output',
  'errors',
  'clientMessages',
  'serverMessages',
] as const;

const outDir = new URL('../test/wire-goldens/', import.meta.url);
const outFile = new URL('wire-goldens.json', outDir);

type AnySchema = Schema.Schema.AnyNoContext;
type Probe = {
  readonly sample: number;
  readonly mutation: Mutation;
  readonly ok: boolean;
  readonly output?: unknown;
};
type Golden = {
  readonly name: string;
  readonly literals?: ReadonlyArray<unknown>;
  readonly samples: ReadonlyArray<{ readonly wire: unknown; readonly reencoded: unknown }>;
  readonly probes: ReadonlyArray<Probe>;
  readonly skipped?: string;
};

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

/** Decode then re-encode; any throw in either direction counts as a reject. */
const decode = (schema: AnySchema, input: unknown): { ok: boolean; output?: unknown } => {
  try {
    const decoded: unknown = Schema.decodeUnknownSync(schema)(input);
    return { ok: true, output: json(Schema.encodeSync(schema)(decoded)) };
  } catch {
    return { ok: false };
  }
};

/** Names match the resolver in `src/wire-goldens.test.ts`: export name or `endpoint:<domain>.<key>.<part>`. */
const collect = (): Map<string, AnySchema> => {
  const found = new Map<string, AnySchema>();
  for (const [name, value] of Object.entries(contracts)) {
    if (Schema.isSchema(value)) found.set(name, value as AnySchema);
  }
  const endpoints = contracts.apiEndpoints as unknown as Record<string, Record<string, unknown>>;
  for (const [domain, group] of Object.entries(endpoints)) {
    const entries =
      'method' in group || 'path' in group ? [[domain, group]] : Object.entries(group);
    for (const [key, endpoint] of entries as Array<[string, Record<string, unknown>]>) {
      for (const part of ENDPOINT_PARTS) {
        const schema = endpoint[part];
        if (Schema.isSchema(schema))
          found.set(`endpoint:${domain}.${key}.${part}`, schema as AnySchema);
      }
    }
  }
  return found;
};

const capture = (name: string, schema: AnySchema): Golden => {
  const literals = (schema as { readonly literals?: unknown }).literals;
  // Draw many, keep the SAMPLES smallest JSON-representable ones: small fixtures, same shape coverage.
  const candidates = FastCheck.sample(Arbitrary.make(schema), { seed: SEED, numRuns: CANDIDATES })
    .map((value) => json(Schema.encodeSync(schema)(value)))
    .map((wire) => ({ wire, size: JSON.stringify(wire).length }))
    .filter((candidate) => candidate.size <= MAX_SAMPLE_BYTES)
    .sort((a, b) => a.size - b.size);
  const seen = new Set<string>();
  const samples: Array<{ wire: unknown; reencoded: unknown }> = [];
  const probes: Probe[] = [];
  for (const { wire } of candidates) {
    const key = JSON.stringify(wire);
    if (seen.has(key) || samples.length >= SAMPLES) continue;
    seen.add(key);
    const roundTrip = decode(schema, wire);
    if (!roundTrip.ok) continue; // Not representable as JSON (e.g. NaN, -0): not a wire value.
    const index = samples.push({ wire, reencoded: roundTrip.output }) - 1;
    for (const mutation of mutationsOf(wire)) {
      probes.push({ sample: index, mutation, ...decode(schema, applyMutation(wire, mutation)) });
    }
  }
  return { name, ...(Array.isArray(literals) ? { literals } : {}), samples, probes };
};

const goldens: Golden[] = [];
for (const [name, schema] of [...collect()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  try {
    goldens.push(capture(name, schema));
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error).split('\n')[0] ?? '';
    goldens.push({ name, samples: [], probes: [], skipped: reason });
  }
}

const effectVersion = (createRequire(import.meta.url)('effect/package.json') as { version: string })
  .version;
mkdirSync(outDir, { recursive: true });
writeFileSync(
  outFile,
  `${JSON.stringify({ capturedWith: `effect@${effectVersion}`, seed: SEED, goldens })}\n`,
);

const skipped = goldens.filter((golden) => golden.skipped !== undefined);
const sampleCount = goldens.reduce((n, golden) => n + golden.samples.length, 0);
const probeCount = goldens.reduce((n, golden) => n + golden.probes.length, 0);
console.log(
  `schemas=${goldens.length} samples=${sampleCount} probes=${probeCount} skipped=${skipped.length}`,
);
for (const golden of skipped) console.log(`  skipped ${golden.name}: ${golden.skipped}`);
console.log(`wrote ${fileURLToPath(outFile)}`);
