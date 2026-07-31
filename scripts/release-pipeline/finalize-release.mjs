#!/usr/bin/env node

import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { publishedAssetRecords, readAndVerifyReleaseManifest } from './artifact-manifest.mjs';
import {
  assertClosedReleaseAssets,
  assertPromotedRelease,
  assertRemoteTag,
  assertSameRelease,
  assertStagedRelease,
  compareReleaseAssets,
  createGitHubAdapter,
  requireReleaseEnvironment,
} from './github-release.mjs';

// Attaches the validated asset set to the staged prerelease and only then promotes it to stable.
// Every write happens while the release is still a prerelease, so a failure at any point leaves a
// release nobody is being offered. Once promotion succeeds this run is done writing; an already
// stable release is reconciled by reconcile-release.mjs, which only reads.
export async function finalizeRelease({ adapter, commitSha, directory, repository, tag, version }) {
  const aggregate = resolve(directory);
  const manifest = readAndVerifyReleaseManifest(aggregate, {
    commitSha,
    tag,
    version,
  });
  const expectedAssets = publishedAssetRecords(manifest);
  await assertRemoteTag(adapter, tag, commitSha);
  const staged = await adapter.getRelease(repository, tag);
  assertStagedRelease(staged, tag);

  const plan = compareReleaseAssets(staged.assets ?? [], expectedAssets);
  const pathsFor = (names) => names.map((name) => resolve(aggregate, name));
  // Absent assets upload without --clobber so a concurrent writer cannot be silently overwritten,
  // and only assets that already differ are clobbered, because --clobber deletes before it uploads.
  // Both cases are safe here only because the release is still a prerelease.
  if (plan.missing.length > 0) {
    await adapter.uploadAssets(repository, tag, pathsFor(plan.missing), { clobber: false });
  }
  if (plan.mismatched.length > 0) {
    await adapter.uploadAssets(repository, tag, pathsFor(plan.mismatched), { clobber: true });
  }

  await assertRemoteTag(adapter, tag, commitSha);
  const attached = await adapter.getRelease(repository, tag);
  assertStagedRelease(attached, tag);
  assertSameRelease(attached, staged, tag);
  assertClosedReleaseAssets(compareReleaseAssets(attached.assets ?? [], expectedAssets), tag);

  await adapter.promoteToStable(repository, tag);
  const promoted = await adapter.getRelease(repository, tag);
  assertPromotedRelease(promoted, tag);
  assertSameRelease(promoted, staged, tag);
  return {
    assetCount: expectedAssets.length,
    release: promoted,
    uploaded: [...plan.missing, ...plan.mismatched].sort(),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw new Error('Usage: finalize-release DIRECTORY');
  const result = await finalizeRelease({
    adapter: createGitHubAdapter(),
    directory,
    ...requireReleaseEnvironment('Usage: finalize-release DIRECTORY'),
  });
  console.log(
    JSON.stringify({
      assetCount: result.assetCount,
      releaseId: result.release.id,
      uploaded: result.uploaded,
    }),
  );
}
