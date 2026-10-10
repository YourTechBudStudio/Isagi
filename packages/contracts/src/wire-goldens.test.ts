/**
 * Contract wire goldens: every captured schema must keep the same wire behavior.
 *
 * `test/wire-goldens/wire-goldens.json` is a frozen oracle captured on effect@3.21.2 before the v4
 * port; entries recaptured since then carry their own `capturedWith`. For each captured schema this test replays the stored wire samples and adversarial probes
 * against the current schema and asserts identical accept/reject decisions, identical re-encoded
 * output, and identical `.literals`. A divergence is a wire change: fix the schema, or, when the
 * change is deliberate and reviewed, recapture only the changed schemas with
 * `pnpm -C packages/contracts exec tsx scripts/capture-wire-goldens.ts --only <name>[,<name>...]`
 * (it lists other names that capture the same schema object, and stamps each recaptured entry with
 * its own `capturedWith`). Never recapture the whole file: v4's sampler differs from v3's, so that
 * would replace the v3 oracle instead of recording one change.
 *
 * A captured name that no longer resolves must be listed in `test/wire-goldens/renames.json`
 * (`{ "oldName": "newName" }`) or `test/wire-goldens/removed.json` (`{ "name": "reason" }`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Exit, Schema } from 'effect';

import * as contracts from './index.js';
import { applyMutation, type Mutation } from './testing/wire-golden-mutations.js';

type AnySchema = Schema.Codec<unknown>;

interface Golden {
  readonly name: string;
  readonly capturedWith?: string;
  readonly literals?: ReadonlyArray<unknown>;
  readonly samples: ReadonlyArray<{ readonly wire: unknown; readonly reencoded: unknown }>;
  readonly probes: ReadonlyArray<{
    readonly sample: number;
    readonly mutation: Mutation;
    readonly ok: boolean;
    readonly output?: unknown;
  }>;
  readonly skipped?: string;
}

const goldensDir = new URL('../test/wire-goldens/', import.meta.url);
const readJson = <A>(file: string): A =>
  JSON.parse(readFileSync(new URL(file, goldensDir), 'utf8')) as A;

const goldens = readJson<{ readonly goldens: ReadonlyArray<Golden> }>('wire-goldens.json').goldens;
const renames = readJson<Readonly<Record<string, string>>>('renames.json');
const removed = readJson<Readonly<Record<string, string>>>('removed.json');

const ENDPOINT_PREFIX = 'endpoint:';

/** Resolves an export name or an `endpoint:<domain>.<key>.<part>` path to a schema, as captured. */
const resolveSchema = (name: string): AnySchema | undefined => {
  if (!name.startsWith(ENDPOINT_PREFIX)) {
    const value = (contracts as Record<string, unknown>)[name];
    return Schema.isSchema(value) ? (value as AnySchema) : undefined;
  }
  const [domain, key, part, ...rest] = name.slice(ENDPOINT_PREFIX.length).split('.');
  if (domain === undefined || key === undefined || part === undefined || rest.length > 0) {
    return undefined;
  }
  const endpoints = contracts.apiEndpoints as unknown as Record<string, Record<string, unknown>>;
  const group = Object.hasOwn(endpoints, domain) ? endpoints[domain] : undefined;
  if (group === undefined) return undefined;
  const isSingleEndpoint = 'method' in group || 'path' in group;
  const endpoint = isSingleEndpoint
    ? key === domain
      ? group
      : undefined
    : Object.hasOwn(group, key)
      ? (group[key] as Record<string, unknown> | undefined)
      : undefined;
  const value = endpoint?.[part];
  return Schema.isSchema(value) ? (value as AnySchema) : undefined;
};

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

/** Decode then re-encode; any failure in either direction counts as a reject (as in the capture). */
const decodeEncode = (schema: AnySchema, input: unknown): { ok: boolean; output?: unknown } => {
  const decoded = Schema.decodeUnknownExit(schema)(input);
  if (Exit.isFailure(decoded)) return { ok: false };
  try {
    return { ok: true, output: json(Schema.encodeSync(schema)(decoded.value)) };
  } catch {
    return { ok: false };
  }
};

/** Returns human-readable divergences; empty means wire-compatible with the capture. */
const diffAgainstGolden = (name: string, schema: AnySchema, golden: Golden): string[] => {
  const problems: string[] = [];
  const literals = (schema as { readonly literals?: unknown }).literals;
  if (golden.literals !== undefined || Array.isArray(literals)) {
    if (JSON.stringify(literals) !== JSON.stringify(golden.literals)) {
      problems.push(
        `${name}: .literals changed from ${JSON.stringify(golden.literals)} to ${JSON.stringify(literals)}`,
      );
    }
  }
  golden.samples.forEach((sample, index) => {
    const result = decodeEncode(schema, sample.wire);
    if (!result.ok) {
      problems.push(
        `${name} sample#${index}: was accepted, now rejected: ${JSON.stringify(sample.wire)}`,
      );
    } else if (JSON.stringify(result.output) !== JSON.stringify(sample.reencoded)) {
      problems.push(
        `${name} sample#${index}: re-encoding changed: ${JSON.stringify(result.output)}`,
      );
    }
  });
  for (const probe of golden.probes) {
    const sample = golden.samples[probe.sample];
    if (sample === undefined) {
      problems.push(`${name}: probe refers to missing sample#${probe.sample}`);
      continue;
    }
    const result = decodeEncode(schema, applyMutation(sample.wire, probe.mutation));
    const label = `${name} sample#${probe.sample} ${JSON.stringify(probe.mutation)}`;
    if (result.ok !== probe.ok) {
      problems.push(`${label}: was ok=${probe.ok}, now ok=${result.ok}`);
    } else if (result.ok && JSON.stringify(result.output) !== JSON.stringify(probe.output)) {
      problems.push(`${label}: output changed: ${JSON.stringify(result.output)}`);
    }
  }
  return problems;
};

const goldensByName = new Map(goldens.map((golden) => [golden.name, golden]));

test('wire goldens were captured without skips', () => {
  assert.ok(goldens.length > 0, 'no goldens captured');
  assert.deepEqual(
    goldens.filter((golden) => golden.skipped !== undefined).map((golden) => golden.name),
    [],
  );
});

test('wire golden renames and removals name captured schemas', () => {
  for (const name of [...Object.keys(renames), ...Object.keys(removed)]) {
    assert.ok(goldensByName.has(name), `${name} is not a captured golden`);
  }
  for (const name of Object.keys(renames)) {
    assert.ok(!Object.hasOwn(removed, name), `${name} is both renamed and removed`);
  }
});

for (const golden of goldens) {
  test(`${golden.name} matches its wire golden`, () => {
    if (Object.hasOwn(removed, golden.name)) {
      assert.equal(
        resolveSchema(golden.name),
        undefined,
        `${golden.name} is listed in removed.json but still resolves`,
      );
      return;
    }
    const currentName = Object.hasOwn(renames, golden.name) ? renames[golden.name] : golden.name;
    assert.ok(currentName !== undefined);
    const schema = resolveSchema(currentName);
    assert.ok(
      schema !== undefined,
      `${currentName} no longer resolves; list it in test/wire-goldens/renames.json or removed.json`,
    );
    assert.deepEqual(diffAgainstGolden(currentName, schema, golden), []);
  });
}

test('the golden harness reports a drifted schema', () => {
  const codeGolden = goldensByName.get('apiInfrastructureErrorCodeSchema');
  const errorGolden = goldensByName.get('apiInfrastructureErrorSchema');
  assert.ok(codeGolden !== undefined && errorGolden !== undefined);

  // A dropped literal and an unconstrained `status`, the kind of drift a port could introduce.
  const droppedLiteral = Schema.Literals([
    'api_request_decoding_failed',
    'api_request_parsing_failed',
    'api_response_encoding_failed',
    'api_route_not_found',
  ]);
  const loosenedError = Schema.Struct({
    code: droppedLiteral,
    status: Schema.Number,
    message: Schema.String,
    requestId: Schema.String,
    data: Schema.optional(Schema.Unknown),
  });

  assert.deepEqual(
    diffAgainstGolden(
      'apiInfrastructureErrorCodeSchema',
      contracts.apiInfrastructureErrorCodeSchema,
      codeGolden,
    ),
    [],
  );
  assert.ok(diffAgainstGolden('droppedLiteral', droppedLiteral, codeGolden).length > 0);
  assert.ok(diffAgainstGolden('loosenedError', loosenedError, errorGolden).length > 0);
});

test('the surfaces error golden pins the session_launch_rejected member', () => {
  const golden = goldensByName.get('surfaceApiErrorSchema');
  assert.ok(golden !== undefined);
  // The union as it was before the launch gate's refusal became a surfaces failure.
  const withoutLaunchRejection = Schema.Union([
    contracts.surfaceRejectedErrorSchema,
    contracts.runtimeDatabaseFailedErrorSchema,
    contracts.runtimeDataDirectoryFailedErrorSchema,
  ]);

  assert.deepEqual(
    diffAgainstGolden('surfaceApiErrorSchema', contracts.surfaceApiErrorSchema, golden),
    [],
  );
  assert.ok(
    diffAgainstGolden('withoutLaunchRejection', withoutLaunchRejection, golden).some((problem) =>
      problem.includes('session_launch_rejected'),
    ),
  );
});
