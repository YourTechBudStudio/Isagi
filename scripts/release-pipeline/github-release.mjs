import { runCommand } from './preflight.mjs';

export function compareReleaseAssets(remoteAssets, expectedAssets) {
  const remoteByName = new Map(remoteAssets.map((asset) => [asset.name, asset]));
  const expectedNames = new Set(expectedAssets.map((asset) => asset.name));
  const missing = [];
  const mismatched = [];
  for (const expected of expectedAssets) {
    const remote = remoteByName.get(expected.name);
    if (!remote) missing.push(expected.name);
    else if (remote.size !== expected.size || remote.digest !== `sha256:${expected.sha256}`) {
      mismatched.push(expected.name);
    }
  }
  return {
    mismatched,
    missing,
    unexpected: remoteAssets
      .filter((asset) => !expectedNames.has(asset.name))
      .map((asset) => asset.name),
  };
}

// The aggregate is a closed manifest, so the release it lands on is closed too: an unverified file
// attached by hand or left behind by an abandoned attempt would otherwise ship alongside the
// official assets under the same implied guarantee.
export function assertClosedReleaseAssets(comparison, tag) {
  const problems = [
    ['missing', comparison.missing],
    ['mismatched', comparison.mismatched],
    ['unexpected', comparison.unexpected],
  ]
    .filter(([, names]) => names.length > 0)
    .map(([label, names]) => `${label} ${names.join(', ')}`);
  if (problems.length > 0) {
    throw new Error(
      `GitHub release ${tag} does not hold exactly the validated asset set (${problems.join('; ')}).`,
    );
  }
}

// Only a staged prerelease may be written to. Once a release is stable it is public, so the
// pipeline never uploads to it again: a rebuild cannot reproduce the original bytes, and replacing
// a public asset deletes the working one before the replacement is known to arrive.
export function assertStagedRelease(release, tag) {
  if (!release) throw new Error(`Published GitHub release ${tag} does not exist.`);
  if (release.draft !== false) {
    throw new Error(`GitHub release ${tag} must be published before its assets can be attached.`);
  }
  if (release.prerelease !== true) {
    // Reaching this means classification ran before the release was promoted, which is what
    // "Re-run failed jobs" does: it reuses the previous run's classification instead of redoing it.
    throw new Error(
      `GitHub release ${tag} is already stable and must not be rewritten; an already-promoted release is verified, never rebuilt onto. If a previous run promoted it and then failed, recover with GitHub's "Re-run all jobs" so classification runs again and selects the read-only verification job. "Re-run failed jobs" reuses the stale classification and lands here again.`,
    );
  }
}

export function assertPromotedRelease(release, tag) {
  if (!release) throw new Error(`Published GitHub release ${tag} does not exist.`);
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error(`GitHub release ${tag} is not a promoted stable release.`);
  }
}

export function assertSameRelease(actual, expected, tag) {
  if (actual.id !== expected.id) {
    throw new Error(`GitHub release ${tag} changed identity while the pipeline was working on it.`);
  }
}

export async function assertRemoteTag(adapter, tag, commitSha) {
  const actual = await adapter.resolveRemoteTag(tag);
  if (actual !== commitSha) {
    throw new Error(`Remote tag ${tag} moved to ${actual}; expected ${commitSha}.`);
  }
}

export function createGitHubAdapter({ run = runCommand } = {}) {
  return {
    downloadAsset: async (repository, tag, name) => {
      const result = await run('gh', [
        'release',
        'download',
        tag,
        '--pattern',
        name,
        '--output',
        '-',
        '--repo',
        repository,
      ]);
      return result.stdout;
    },
    getRelease: async (repository, tag) => {
      try {
        return parseJson(await run('gh', ['api', `repos/${repository}/releases/tags/${tag}`]));
      } catch (cause) {
        if (/HTTP 404|Not Found/u.test(String(cause))) return undefined;
        throw cause;
      }
    },
    promoteToStable: async (repository, tag) => {
      await run('gh', [
        'release',
        'edit',
        tag,
        '--prerelease=false',
        '--latest=true',
        '--repo',
        repository,
      ]);
    },
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
    uploadAssets: async (repository, tag, paths, { clobber }) => {
      await run('gh', [
        'release',
        'upload',
        tag,
        ...paths,
        ...(clobber ? ['--clobber'] : []),
        '--repo',
        repository,
      ]);
    },
  };
}

export function requireReleaseEnvironment(usage) {
  const repository = process.env.GITHUB_REPOSITORY;
  const tag = process.env.RELEASE_TAG;
  const version = process.env.RELEASE_VERSION;
  const commitSha = process.env.RELEASE_COMMIT;
  if (!repository || !tag || !version || !commitSha) {
    throw new Error(
      `${usage} (requires GITHUB_REPOSITORY, RELEASE_TAG, RELEASE_VERSION, and RELEASE_COMMIT)`,
    );
  }
  return { commitSha, repository, tag, version };
}

function parseJson(result) {
  return JSON.parse(result.stdout);
}
