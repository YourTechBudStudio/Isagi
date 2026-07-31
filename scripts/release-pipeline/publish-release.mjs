#!/usr/bin/env node

import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { publishedAssetRecords, readAndVerifyReleaseManifest } from './artifact-manifest.mjs';
import { runCommand } from './preflight.mjs';

export function decideReleaseAction(release, expectedAssets) {
  if (!release) return { _tag: 'create_draft' };
  assertStableReleaseState(release, 'Existing release');
  const comparison = compareRemoteAssets(release.assets ?? [], expectedAssets);
  if (release.draft === true) return { _tag: 'synchronize_draft', comparison, release };
  if (comparison.exact) return { _tag: 'published_noop', release };
  return { _tag: 'published_mismatch', comparison, release };
}

export function compareRemoteAssets(remoteAssets, expectedAssets) {
  const expectedByName = new Map(expectedAssets.map((asset) => [asset.name, asset]));
  const remoteByName = new Map(remoteAssets.map((asset) => [asset.name, asset]));
  const missing = [];
  const mismatched = [];
  const unexpected = [];
  const seen = new Set();
  for (const expected of expectedAssets) {
    const remote = remoteByName.get(expected.name);
    if (!remote) missing.push(expected.name);
    else if (remote.size !== expected.size || remote.digest !== `sha256:${expected.sha256}`) {
      mismatched.push(expected.name);
    }
  }
  for (const remote of remoteAssets) {
    if (seen.has(remote.name) || !expectedByName.has(remote.name)) unexpected.push(remote.name);
    seen.add(remote.name);
  }
  return {
    exact: missing.length === 0 && mismatched.length === 0 && unexpected.length === 0,
    mismatched,
    missing,
    unexpected,
  };
}

export async function publishRelease({ adapter, commitSha, directory, repository, tag, version }) {
  const aggregate = resolve(directory);
  const manifest = readAndVerifyReleaseManifest(aggregate, {
    commitSha,
    tag,
    version,
  });
  const expectedAssets = publishedAssetRecords(manifest);
  await assertRemoteTag(adapter, tag, commitSha);
  let release = await adapter.getRelease(repository, tag);
  const decision = decideReleaseAction(release, expectedAssets);
  if (decision._tag === 'published_mismatch') {
    throw new Error(
      'Published release assets differ from the closed manifest; refusing to modify it.',
    );
  }
  if (decision._tag === 'published_noop') return { action: decision._tag, release };
  if (decision._tag === 'create_draft') {
    release = await adapter.createDraft(repository, { commitSha, tag, version });
  }
  await synchronizeDraft({
    adapter,
    directory: aggregate,
    expectedAssets,
    release,
    repository,
    tag,
  });
  const verifiedDraft = await adapter.getRelease(repository, tag);
  assertStableReleaseState(verifiedDraft, 'Synchronized release');
  if (verifiedDraft.draft !== true) {
    throw new Error('Release stopped being a draft during synchronization.');
  }
  const remoteComparison = compareRemoteAssets(verifiedDraft.assets ?? [], expectedAssets);
  if (!remoteComparison.exact) throw new Error('Draft assets do not match the closed manifest.');
  await assertRemoteTag(adapter, tag, commitSha);
  const published = await adapter.publishDraft(repository, verifiedDraft.id);
  assertStableReleaseState(published, 'Publication response');
  if (published.draft !== false) {
    throw new Error(
      'Publication response did not confirm a public stable release; manual inspection is required.',
    );
  }
  return { action: 'published', release: published };
}

async function synchronizeDraft({ adapter, directory, expectedAssets, release, repository, tag }) {
  assertStableReleaseState(release, 'Draft release');
  if (release.draft !== true) throw new Error('Only an existing draft may be synchronized.');
  const comparison = compareRemoteAssets(release.assets ?? [], expectedAssets);
  const remove = new Set([...comparison.mismatched, ...comparison.unexpected]);
  for (const asset of release.assets ?? []) {
    if (remove.has(asset.name)) await adapter.deleteAsset(repository, asset.id);
  }
  const upload = new Set([...comparison.missing, ...comparison.mismatched]);
  for (const asset of expectedAssets) {
    if (upload.has(asset.name)) await adapter.uploadAsset(tag, resolve(directory, asset.name));
  }
}

export function assertStableReleaseState(release, label) {
  if (!release || (release.draft !== true && release.draft !== false)) {
    throw new Error(`${label} does not explicitly declare draft=true or draft=false.`);
  }
  if (release.prerelease !== false) {
    throw new Error(`${label} does not explicitly declare prerelease=false.`);
  }
}

async function assertRemoteTag(adapter, tag, commitSha) {
  const actual = await adapter.resolveRemoteTag(tag);
  if (actual !== commitSha) {
    throw new Error(`Remote tag ${tag} moved to ${actual}; expected ${commitSha}.`);
  }
}

export function createGitHubAdapter({ run = runCommand } = {}) {
  return {
    createDraft: async (repository, release) =>
      parseJson(
        await run('gh', [
          'api',
          '--method',
          'POST',
          `repos/${repository}/releases`,
          '-f',
          `tag_name=${release.tag}`,
          '-f',
          `target_commitish=${release.commitSha}`,
          '-f',
          `name=Isagi ${release.version}`,
          '-F',
          'draft=true',
          '-F',
          'prerelease=false',
          '-F',
          'generate_release_notes=true',
        ]),
      ),
    deleteAsset: async (repository, assetId) => {
      await run('gh', [
        'api',
        '--method',
        'DELETE',
        `repos/${repository}/releases/assets/${assetId}`,
      ]);
    },
    getRelease: async (repository, tag) => {
      try {
        return parseJson(await run('gh', ['api', `repos/${repository}/releases/tags/${tag}`]));
      } catch (cause) {
        if (/HTTP 404|Not Found/u.test(String(cause))) return undefined;
        throw cause;
      }
    },
    publishDraft: async (repository, releaseId) =>
      parseJson(
        await run('gh', [
          'api',
          '--method',
          'PATCH',
          `repos/${repository}/releases/${releaseId}`,
          '-F',
          'draft=false',
        ]),
      ),
    resolveRemoteTag: async (tag) => {
      const result = await run('git', [
        'ls-remote',
        'origin',
        `refs/tags/${tag}`,
        `refs/tags/${tag}^{}`,
      ]);
      const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
      const selected =
        lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`)) ??
        lines.find((line) => line.endsWith(`refs/tags/${tag}`));
      if (!selected) throw new Error(`Remote tag ${tag} is missing.`);
      return selected.split(/\s+/u)[0];
    },
    uploadAsset: async (tag, path) => {
      await run('gh', ['release', 'upload', tag, path]);
    },
  };
}

function parseJson(result) {
  return JSON.parse(result.stdout);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  const tag = process.env.RELEASE_TAG;
  const version = process.env.RELEASE_VERSION;
  const commitSha = process.env.RELEASE_COMMIT;
  if (!directory || !repository || !tag || !version || !commitSha) {
    throw new Error(
      `Usage: publish-release DIRECTORY (requires GITHUB_REPOSITORY, RELEASE_TAG, RELEASE_VERSION, and RELEASE_COMMIT)`,
    );
  }
  const result = await publishRelease({
    adapter: createGitHubAdapter(),
    commitSha,
    directory,
    repository,
    tag,
    version,
  });
  console.log(JSON.stringify({ action: result.action, releaseId: result.release.id }));
}
