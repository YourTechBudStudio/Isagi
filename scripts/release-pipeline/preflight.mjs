#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';

import { classifyReleaseTag, parseCanonicalVersion } from '../release-version-contract.mjs';
import { verifyPackageVersions } from '../sync-package-versions.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function preflightRelease({ adapters, commitSha, repoRoot, tag }) {
  const classification = classifyReleaseTag(tag);
  if (classification._tag === 'invalid_tag' || classification._tag === 'unrelated') {
    throw new Error(`Tag ${tag} is not a supported release tag.`);
  }
  if (classification._tag === 'prerelease_ignored') {
    return { commitSha, kind: classification._tag, tag, version: classification.version };
  }

  const plan = adapters.verifyVersions
    ? await adapters.verifyVersions(repoRoot)
    : await Effect.runPromise(verifyPackageVersions({ repoRoot }));
  if (plan.version !== classification.version) {
    throw new Error(`Tag ${tag} does not match synchronized application version ${plan.version}.`);
  }
  await adapters.assertMainAncestor(commitSha);
  const remoteCommit = await adapters.resolveRemoteTag(tag);
  if (remoteCommit !== commitSha) {
    throw new Error(`Remote tag ${tag} resolves to ${remoteCommit}, expected ${commitSha}.`);
  }
  const releases = await adapters.listReleases();
  assertStrictlyIncreasing(classification.version, tag, releases);
  return {
    commitSha,
    kind: classification._tag,
    tag,
    version: classification.version,
  };
}

export function assertStrictlyIncreasing(version, currentTag, releases) {
  const current = parseCanonicalVersion(version);
  if (current._tag !== 'canonical_version') throw new Error(`Invalid stable version ${version}.`);
  const published = releases
    .filter(
      (release) =>
        release.draft === false && release.prerelease === false && release.tag_name !== currentTag,
    )
    .map((release) => classifyReleaseTag(release.tag_name))
    .filter((classification) => classification._tag === 'stable_release');
  for (const release of published) {
    if (compareVersions(current, parseCanonicalVersion(release.version)) <= 0) {
      throw new Error(
        `Version ${version} is not greater than published stable version ${release.version}.`,
      );
    }
  }
}

export function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    const order = BigInt(left[key]) - BigInt(right[key]);
    if (order < 0n) return -1;
    if (order > 0n) return 1;
  }
  return 0;
}

export function createPreflightAdapters({ repository, run }) {
  return {
    assertMainAncestor: async (commitSha) => {
      await run('git', ['merge-base', '--is-ancestor', commitSha, 'origin/main']);
    },
    listReleases: async () => {
      const result = await run('gh', [
        'api',
        '--paginate',
        `repos/${repository}/releases?per_page=100`,
        '--slurp',
      ]);
      return JSON.parse(result.stdout).flat();
    },
    resolveRemoteTag: async (tag) => {
      const result = await run('git', [
        'ls-remote',
        'origin',
        `refs/tags/${tag}`,
        `refs/tags/${tag}^{}`,
      ]);
      const records = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
      const peeled = records.find((record) => record.endsWith(`refs/tags/${tag}^{}`));
      const selected = peeled ?? records.find((record) => record.endsWith(`refs/tags/${tag}`));
      if (!selected) throw new Error(`Remote tag ${tag} is missing.`);
      return selected.split(/\s+/u)[0];
    },
  };
}

export function runCommand(command, args) {
  return Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        const { spawn } = await import('node:child_process');
        return new Promise((resolvePromise, reject) => {
          const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (chunk) => (stdout += chunk));
          child.stderr.on('data', (chunk) => (stderr += chunk));
          child.once('error', reject);
          child.once('exit', (code) => {
            if (code === 0) resolvePromise({ stderr, stdout });
            else reject(new Error(`${command} ${args.join(' ')} failed: ${stderr.trim()}`));
          });
        });
      },
      catch: (cause) => cause,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.env.GITHUB_REF_NAME;
  const commitSha = process.env.GITHUB_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!tag || !commitSha || !repository) throw new Error('GitHub release context is incomplete.');
  const result = await preflightRelease({
    adapters: createPreflightAdapters({ repository, run: runCommand }),
    commitSha,
    repoRoot: repositoryRoot,
    tag,
  });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Release classification\n\n- Kind: \`${result.kind}\`\n- Tag: \`${result.tag}\`\n- Version: \`${result.version}\`\n- Commit: \`${result.commitSha}\`\n`,
    );
  }
  console.log(JSON.stringify(result));
}
