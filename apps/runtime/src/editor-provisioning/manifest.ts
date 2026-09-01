import process from 'node:process';

import { Schema } from 'effect';

import { codeServerManifestSource } from '../runtime-assets.js';

// The release pin, as shipped data rather than as code.
//
// `code-server.manifest.json` is repository-owned source copied verbatim into
// the runtime asset root at build time. It is deliberately *not* configuration:
// there is no `.isagi/config.yaml` key, no mirror, no version override, and no
// release discovery at run time. A pin the product ships is a pin the product
// can be held to — the digest below is what makes a download either exactly the
// audited artifact or a modelled `integrity_mismatch` failure.
//
// Everything here is evaluated at module load, so a malformed or missing
// manifest throws during import. That is the correct shape: the asset ships
// inside the binary, so bad bytes are a build defect, not an operational
// condition any runtime could recover from or usefully report.

/**
 * The three targets `.github/workflows/release.yml` actually builds. `linux-arm64`
 * exists upstream but Isagi does not ship it, so it resolves to `null` here and
 * becomes the modelled `unsupported_platform` state rather than a crash.
 */
export type EditorPlatformKey = 'darwin-arm64' | 'darwin-x64' | 'linux-x64';

const sha256Pattern = /^[0-9a-f]{64}$/;

const codeServerArtifactSchema = Schema.Struct({
  url: Schema.String.pipe(Schema.minLength(1)),
  /** Lowercase hex, because that is what `crypto.Hash.digest('hex')` produces
   *  and the comparison in `install.ts` is an exact string equality. */
  sha256: Schema.String.pipe(Schema.pattern(sha256Pattern)),
  archive: Schema.Literal('tar_gz'),
  stripComponents: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  /** POSIX-relative to the install root. An absolute path would break the
   *  moment the data directory moves. */
  executablePath: Schema.String.pipe(Schema.minLength(1)),
});

const codeServerManifestSchema = Schema.Struct({
  manifestVersion: Schema.Literal(1),
  version: Schema.String.pipe(Schema.minLength(1)),
  // A struct with three required members rather than a record: the supported
  // matrix is a closed set that must match the release workflow, and stating it
  // structurally means a missing target fails at import instead of at the moment
  // a user on that platform tries to open an editor.
  artifacts: Schema.Struct({
    'darwin-arm64': codeServerArtifactSchema,
    'darwin-x64': codeServerArtifactSchema,
    'linux-x64': codeServerArtifactSchema,
  }),
});

export type CodeServerArtifact = Schema.Schema.Type<typeof codeServerArtifactSchema>;
export type CodeServerManifest = Schema.Schema.Type<typeof codeServerManifestSchema>;

export const codeServerManifest: CodeServerManifest = Schema.decodeUnknownSync(
  codeServerManifestSchema,
)(JSON.parse(codeServerManifestSource));

export function artifactForPlatform(
  manifest: CodeServerManifest,
  key: EditorPlatformKey,
): CodeServerArtifact {
  return manifest.artifacts[key];
}

/**
 * Maps a host to its release target, or `null` for anything Isagi does not ship.
 *
 * Takes its input rather than reading `process` so the mapping is testable
 * without touching a process global — the live call site below is the only place
 * the real platform is read.
 */
export function editorPlatformKey(input: {
  readonly platform: string;
  readonly arch: string;
}): EditorPlatformKey | null {
  if (input.platform === 'darwin' && input.arch === 'arm64') return 'darwin-arm64';
  if (input.platform === 'darwin' && input.arch === 'x64') return 'darwin-x64';
  if (input.platform === 'linux' && input.arch === 'x64') return 'linux-x64';
  return null;
}

export function hostEditorPlatformKey(): EditorPlatformKey | null {
  return editorPlatformKey({ platform: process.platform, arch: process.arch });
}
