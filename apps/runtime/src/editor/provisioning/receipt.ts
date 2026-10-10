import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Schema } from 'effect';

import type { CodeServerArtifact, EditorPlatformKey } from './manifest.js';

// The completion record for one install root.
//
// It is written *last* and atomically, so its presence is the only evidence an
// install finished. Everything else on disk — an extracted tree, an executable
// bit — can exist halfway through an interrupted attempt; a decodable receipt
// cannot.
//
// An unreadable, undecodable, or mismatched receipt is never repaired in place.
// It means "not provisioned", and the version directory is rebuilt from scratch.
// Repair would require trusting a tree whose provenance is exactly what the
// receipt was supposed to establish.

export const editorInstallReceiptFileName = '.isagi-install.json';

export const editorInstallReceiptSchema = Schema.Struct({
  receiptVersion: Schema.Literal(1),
  version: Schema.String,
  platformKey: Schema.String,
  artifactSha256: Schema.String,
  /** POSIX-relative to the install root, for the same reason the manifest's is. */
  executablePath: Schema.String,
  completedAt: Schema.String,
});

export type EditorInstallReceipt = Schema.Schema.Type<typeof editorInstallReceiptSchema>;

const decodeReceipt = Schema.decodeUnknownSync(editorInstallReceiptSchema);

export function editorInstallReceiptPath(installRoot: string) {
  return join(installRoot, editorInstallReceiptFileName);
}

/**
 * Reads the receipt, or returns `null` for every reason it might not be usable:
 * absent, unreadable, not JSON, or not this schema version.
 *
 * Deliberately total. The caller has exactly one decision to make — reuse or
 * re-provision — so distinguishing "no file" from "corrupt file" would produce a
 * failure channel with no branch behind it. The re-provision path overwrites
 * whatever is there either way.
 */
export function readEditorInstallReceipt(installRoot: string): EditorInstallReceipt | null {
  try {
    return decodeReceipt(JSON.parse(readFileSync(editorInstallReceiptPath(installRoot), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * True when this receipt describes exactly the installation the current manifest
 * asks for: version, platform, artifact digest, and the executable path itself.
 *
 * The path is part of the match rather than something the reuse path adopts from
 * the receipt. A receipt is a file on disk, so treating its `executablePath` as
 * authoritative would let a tampered or corrupt record point provisioning at a
 * binary outside the verified install root — `../../../../bin/sh` matches every
 * other field just as well. Requiring equality with the manifest's own relative
 * path keeps the executable bound to the artifact the digest actually covers.
 *
 * It re-hashes nothing. The digest was verified against the downloaded bytes at
 * install time and the receipt was written last to record that; re-hashing a
 * ~200 MB tree on every runtime start would spend minutes to re-derive a fact
 * the write ordering already establishes (AC2).
 */
export function editorInstallReceiptMatches(
  receipt: EditorInstallReceipt,
  expected: {
    readonly version: string;
    readonly platformKey: EditorPlatformKey;
    readonly artifact: CodeServerArtifact;
  },
) {
  return (
    receipt.receiptVersion === 1 &&
    receipt.version === expected.version &&
    receipt.platformKey === expected.platformKey &&
    receipt.artifactSha256 === expected.artifact.sha256 &&
    receipt.executablePath === expected.artifact.executablePath
  );
}

/**
 * Writes the receipt through a temporary file and a rename, so a reader never
 * observes a partially written completion record.
 *
 * Throws on failure; the caller runs it inside the install's uninterruptible
 * publish step and maps a throw to `install_unusable`.
 */
export function writeEditorInstallReceipt(installRoot: string, receipt: EditorInstallReceipt) {
  const finalPath = editorInstallReceiptPath(installRoot);
  const temporaryPath = `${finalPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, finalPath);
}
