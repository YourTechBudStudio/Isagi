#!/usr/bin/env node

import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  publishedAssetRecords,
  releaseManifestName,
  serializeReleaseManifest,
  validateReleaseManifest,
} from './artifact-manifest.mjs';
import {
  assertClosedReleaseAssets,
  assertPromotedRelease,
  assertRemoteTag,
  compareReleaseAssets,
  createGitHubAdapter,
  requireReleaseEnvironment,
} from './github-release.mjs';

// Verifies an already-promoted stable release without writing to it.
//
// This is the recovery path for the one ambiguous outcome the pipeline has: promotion is applied
// but the run fails before it can confirm it. Rerunning must not rebuild onto that release. Signed
// macOS artifacts and the generated update metadata are not byte-reproducible, so a fresh build
// would disagree with the assets already published and replacing them would delete working public
// downloads. The authority here is therefore the manifest the original run attached, not a rebuild:
// GitHub reports each asset's size and SHA-256, so the complete set can be proven from metadata
// alone. Either the release already holds exactly what its manifest describes, or a human is told
// precisely what diverged.
export async function reconcileRelease({ adapter, commitSha, repository, tag, version }) {
  await assertRemoteTag(adapter, tag, commitSha);
  const release = await adapter.getRelease(repository, tag);
  assertPromotedRelease(release, tag);

  const contents = await adapter.downloadAsset(repository, tag, releaseManifestName);
  const manifest = parseAttachedManifest(contents, tag);
  validateReleaseManifest(manifest, { commitSha, tag, version });
  const expectedAssets = publishedAssetRecords(manifest);
  assertClosedReleaseAssets(compareReleaseAssets(release.assets ?? [], expectedAssets), tag);
  return { assetCount: expectedAssets.length, release };
}

function parseAttachedManifest(contents, tag) {
  let manifest;
  try {
    manifest = JSON.parse(contents);
  } catch (cause) {
    throw new Error(`Release ${tag} has an unreadable ${releaseManifestName}.`, { cause });
  }
  // The pipeline is the only writer of this asset and always writes canonical bytes, so anything
  // else means the attached manifest is not the one a pipeline run produced.
  if (contents !== serializeReleaseManifest(manifest)) {
    throw new Error(`Release ${tag} has a ${releaseManifestName} the pipeline did not write.`);
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await reconcileRelease({
    adapter: createGitHubAdapter(),
    ...requireReleaseEnvironment('Usage: reconcile-release'),
  });
  console.log(
    JSON.stringify({ assetCount: result.assetCount, releaseId: result.release.id, verified: true }),
  );
}
