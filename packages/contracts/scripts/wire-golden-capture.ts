/**
 * Capture logic for the contract wire goldens checked by `src/wire-goldens.test.ts`.
 *
 * For every Schema exported by `@isagi/contracts` and every schema part of every endpoint in
 * `apiEndpoints`, a golden stores a few small JSON wire samples, their re-encoded output, the
 * schema's `.literals`, and the accept/reject decision (plus re-encoded output) for deterministic
 * adversarial probes. Sampling is seeded per schema, so capturing one schema gives the same entry
 * as capturing it inside a full run, and two captures of the same contracts are byte-identical.
 *
 * The command-line entry point is `capture-wire-goldens.ts`; this module has no side effects so the
 * contracts tests can exercise it.
 */
import { createRequire } from 'node:module';

import { Arbitrary, Effect, Exit, Schema } from 'effect';

import * as contracts from '../src/index.js';
import { applyMutation, mutationsOf, type Mutation } from '../src/testing/wire-golden-mutations.js';

export const SEED = 20261009;
export const SAMPLES = 3;
export const CANDIDATES = 40;
export const MAX_SAMPLE_BYTES = 2_000;
const ENDPOINT_PARTS = [
  'params',
  'query',
  'body',
  'output',
  'errors',
  'clientMessages',
  'serverMessages',
] as const;

export const goldensFile = new URL('../test/wire-goldens/wire-goldens.json', import.meta.url);

export type WireSchema = Schema.Codec<unknown>;

export interface WireGoldenProbe {
  readonly sample: number;
  readonly mutation: Mutation;
  readonly ok: boolean;
  readonly output?: unknown;
}

export interface WireGolden {
  readonly name: string;
  /**
   * The effect version this entry was captured with, when it differs from the file's
   * `capturedWith` (an entry recaptured with `--only` after a deliberate wire change).
   */
  readonly capturedWith?: string;
  readonly literals?: ReadonlyArray<unknown>;
  readonly samples: ReadonlyArray<{ readonly wire: unknown; readonly reencoded: unknown }>;
  readonly probes: ReadonlyArray<WireGoldenProbe>;
  readonly skipped?: string;
}

export interface WireGoldensFile {
  readonly capturedWith: string;
  readonly seed: number;
  readonly goldens: ReadonlyArray<WireGolden>;
}

export const installedEffect = (): string =>
  `effect@${(createRequire(import.meta.url)('effect/package.json') as { version: string }).version}`;

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

/** Decode then re-encode; any failure in either direction counts as a reject (as in the test). */
const decodeEncode = (schema: WireSchema, input: unknown): { ok: boolean; output?: unknown } => {
  const decoded = Schema.decodeUnknownExit(schema)(input);
  if (Exit.isFailure(decoded)) return { ok: false };
  const encoded = Schema.encodeUnknownExit(schema)(decoded.value);
  return Exit.isFailure(encoded) ? { ok: false } : { ok: true, output: json(encoded.value) };
};

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every captured schema, by golden name: export name or `endpoint:<domain>.<key>.<part>`. */
export const collectSchemas = (): ReadonlyMap<string, WireSchema> => {
  const found = new Map<string, WireSchema>();
  for (const [name, value] of Object.entries(contracts)) {
    if (Schema.isSchema(value)) found.set(name, value as WireSchema);
  }
  const endpoints = contracts.apiEndpoints as unknown as Record<string, Record<string, unknown>>;
  for (const [domain, group] of Object.entries(endpoints)) {
    const entries =
      'method' in group || 'path' in group ? [[domain, group]] : Object.entries(group);
    for (const [key, endpoint] of entries as Array<[string, Record<string, unknown>]>) {
      for (const part of ENDPOINT_PARTS) {
        const schema = endpoint[part];
        if (Schema.isSchema(schema))
          found.set(`endpoint:${domain}.${key}.${part}`, schema as WireSchema);
      }
    }
  }
  return new Map([...found].sort(([a], [b]) => byName(a, b)));
};

/**
 * Draws CANDIDATES values from `source`, encodes them with `schema` (the captured schema, so a
 * member's value is encoded the way the whole union puts it on the wire) and orders the
 * JSON-representable ones by size.
 */
const candidatesOf = (schema: WireSchema, source: WireSchema): ReadonlyArray<unknown> =>
  Effect.runSync(
    Arbitrary.sampleEffect(Arbitrary.schema(source), { seed: SEED, count: CANDIDATES }),
  )
    .map((value) => json(Schema.encodeSync(schema)(value)))
    .map((wire) => ({ wire, size: JSON.stringify(wire).length }))
    .filter((candidate) => candidate.size <= MAX_SAMPLE_BYTES)
    .sort((a, b) => a.size - b.size)
    .map((candidate) => candidate.wire);

/**
 * The members of a `Schema.Union` whose samples the golden must contain. `Schema.Literals` is
 * skipped: its `.literals` are compared directly.
 */
const unionMembers = (schema: WireSchema): ReadonlyArray<WireSchema> => {
  const { members, literals } = schema as {
    readonly members?: unknown;
    readonly literals?: unknown;
  };
  if (!Array.isArray(members) || Array.isArray(literals)) return [];
  return members.filter((member): member is WireSchema => Schema.isSchema(member));
};

const covers = (member: WireSchema, wire: unknown): boolean =>
  Exit.isSuccess(Schema.decodeUnknownExit(member)(wire));

const captureOrThrow = (name: string, schema: WireSchema): WireGolden => {
  const literals = (schema as { readonly literals?: unknown }).literals;
  const seen = new Set<string>();
  const samples: Array<{ wire: unknown; reencoded: unknown }> = [];
  const probes: WireGoldenProbe[] = [];
  /** Adds `wire` as a sample with its probes; false when it is a duplicate or not a wire value. */
  const addSample = (wire: unknown): boolean => {
    const key = JSON.stringify(wire);
    if (seen.has(key)) return false;
    seen.add(key);
    const roundTrip = decodeEncode(schema, wire);
    if (!roundTrip.ok) return false; // Not representable as JSON (e.g. NaN, -0): not a wire value.
    const index = samples.push({ wire, reencoded: roundTrip.output }) - 1;
    for (const mutation of mutationsOf(wire)) {
      probes.push({
        sample: index,
        mutation,
        ...decodeEncode(schema, applyMutation(wire, mutation)),
      });
    }
    return true;
  };
  // Draw many, keep the SAMPLES smallest JSON-representable ones: small fixtures, same shape coverage.
  for (const wire of candidatesOf(schema, schema)) {
    if (samples.length >= SAMPLES) break;
    addSample(wire);
  }
  // The smallest samples of a union are usually all one member. Add the smallest sample of every
  // member they miss, so adding or dropping a union member (a new error code) is a golden change.
  for (const member of unionMembers(schema)) {
    if (samples.some((sample) => covers(member, sample.wire))) continue;
    for (const wire of candidatesOf(schema, member)) if (addSample(wire)) break;
  }
  return { name, ...(Array.isArray(literals) ? { literals } : {}), samples, probes };
};

/** Captures one schema. A schema the sampler cannot handle comes back with `skipped` set. */
export const captureGolden = (name: string, schema: WireSchema): WireGolden => {
  try {
    return captureOrThrow(name, schema);
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error).split('\n')[0] ?? '';
    return { name, samples: [], probes: [], skipped: reason };
  }
};

/** Captures every schema, as a whole file stamped with the installed effect version. */
export const captureAll = (): WireGoldensFile => ({
  capturedWith: installedEffect(),
  seed: SEED,
  goldens: [...collectSchemas()].map(([name, schema]) => captureGolden(name, schema)),
});

/**
 * Replaces (or inserts, in name order) only the given entries and keeps every other entry and the
 * file's own `capturedWith` stamp. A recaptured entry records its own `capturedWith` when it was
 * captured with a different effect version than the file. Refuses skipped entries and a seed that
 * differs from the file's: either would silently weaken the frozen oracle.
 */
export const mergeGoldens = (
  file: WireGoldensFile,
  recaptured: ReadonlyArray<WireGolden>,
  capturedWith: string,
): WireGoldensFile => {
  if (file.seed !== SEED) {
    throw new Error(`wire-goldens.json was captured with seed ${file.seed}, not ${SEED}`);
  }
  const replacements = new Map<string, WireGolden>();
  for (const golden of recaptured) {
    if (golden.skipped !== undefined) {
      throw new Error(`${golden.name} could not be captured: ${golden.skipped}`);
    }
    const { name, capturedWith: _ignored, ...rest } = golden;
    replacements.set(
      name,
      capturedWith === file.capturedWith ? { name, ...rest } : { name, capturedWith, ...rest },
    );
  }
  const goldens = file.goldens.map((golden) => replacements.get(golden.name) ?? golden);
  const existing = new Set(file.goldens.map((golden) => golden.name));
  for (const [name, golden] of replacements) if (!existing.has(name)) goldens.push(golden);
  goldens.sort((a, b) => byName(a.name, b.name));
  return { capturedWith: file.capturedWith, seed: file.seed, goldens };
};

/** The exact bytes stored on disk: one line of JSON. */
export const serializeGoldens = (file: WireGoldensFile): string => `${JSON.stringify(file)}\n`;
