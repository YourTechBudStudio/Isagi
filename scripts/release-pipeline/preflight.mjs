#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Cause, Effect, Exit } from 'effect';

import { classifyReleaseTag, parseCanonicalVersion } from '../release-version-contract.mjs';
import { verifyPackageVersions } from '../sync-package-versions.mjs';
import { releaseManifestName } from './artifact-manifest.mjs';

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
  const releaseState = classifyPipelineReleaseState(tag, releases);
  assertStrictlyIncreasing(classification.version, tag, releases);
  return {
    commitSha,
    kind: classification._tag,
    releaseState,
    tag,
    version: classification.version,
  };
}

// A stable release is the pipeline's output, never its input: publishing one before the assets
// exist would announce a version nobody can download and no later failure could retract it. The
// staged prerelease is the state the pipeline starts from, and it promotes that release to stable
// itself once the complete validated asset set is attached.
//
// The one stable release the pipeline may re-enter is one a previous run already promoted, which
// happens when promotion succeeds but the run fails while confirming it. That case is provable
// rather than assumed: only the pipeline attaches the release manifest, so a stable release
// carrying it is a run to reconcile, and a stable release without it was published by hand.
export function classifyPipelineReleaseState(tag, releases) {
  const release = releases.find((candidate) => candidate.tag_name === tag);
  if (!release) {
    throw new Error(
      `Published GitHub release ${tag} is required before the release workflow can run.`,
    );
  }
  if (release.draft !== false) {
    throw new Error(
      `GitHub release ${tag} is still a draft; publish it as a prerelease to start the release pipeline.`,
    );
  }
  if (release.prerelease === true) return 'staged';
  if (!(release.assets ?? []).some((asset) => asset.name === releaseManifestName)) {
    throw new Error(
      `GitHub release ${tag} is already stable but carries no ${releaseManifestName}; publish the release as a prerelease and let the pipeline promote it.`,
    );
  }
  return 'promoted';
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
      try {
        await run('git', ['merge-base', '--is-ancestor', commitSha, 'origin/main']);
      } catch (cause) {
        // git merge-base --is-ancestor reserves exit 1 for the answer "no"; every other
        // failure means the check itself could not run and must stay distinguishable.
        if (cause?.exitCode === 1) {
          throw new Error(`Tagged commit ${commitSha} is not reachable from origin/main.`, {
            cause,
          });
        }
        throw new Error(
          `Ancestry check for ${commitSha} against origin/main could not be completed: ${String(cause?.message ?? cause)}`,
          { cause },
        );
      }
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

export async function runCommand(command, args) {
  // Callers classify failures by exit status, so the original error must survive the
  // Effect boundary rather than arriving as an opaque FiberFailure.
  const exit = await Effect.runPromiseExit(
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
          child.once('exit', (code, signal) => {
            if (code === 0) resolvePromise({ stderr, stdout });
            else {
              const outcome = code === null ? `signal ${signal}` : `exit ${code}`;
              reject(
                Object.assign(
                  new Error(`${command} ${args.join(' ')} failed (${outcome}): ${stderr.trim()}`),
                  { exitCode: code, signal, stderr, stdout },
                ),
              );
            }
          });
        });
      },
      catch: (cause) => cause,
    }),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

export function formatPreflightSummary({ error, result, tag, commitSha }) {
  if (result) {
    const state = result.releaseState
      ? `\n- Release state: \`${result.releaseState}\`${
          result.releaseState === 'promoted'
            ? ' (reconciling a release a previous run already promoted)'
            : ''
        }`
      : '';
    return `## Release classification\n\n- Kind: \`${result.kind}\`\n- Tag: \`${result.tag}\`\n- Version: \`${result.version}\`\n- Commit: \`${result.commitSha}\`${state}\n`;
  }
  return `## Release classification failed\n\n- Tag: \`${tag}\`\n- Commit: \`${commitSha}\`\n- Reason: ${String(error?.message ?? error)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
  const commitSha = process.env.RELEASE_COMMIT ?? process.env.GITHUB_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!tag || !commitSha || !repository) throw new Error('GitHub release context is incomplete.');
  let result;
  try {
    result = await preflightRelease({
      adapters: createPreflightAdapters({ repository, run: runCommand }),
      commitSha,
      repoRoot: repositoryRoot,
      tag,
    });
  } catch (error) {
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        formatPreflightSummary({ commitSha, error, tag }),
      );
    }
    throw error;
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatPreflightSummary({ result }));
  }
  console.log(JSON.stringify(result));
}
