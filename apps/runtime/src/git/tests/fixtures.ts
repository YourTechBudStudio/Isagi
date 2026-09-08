import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Real Git fixtures for project-root classification.
 *
 * Classification is about what Git actually answers for a given layout, so these
 * are real repositories built by real `git` rather than doubles. That makes the
 * host environment part of the test, and this module is where those assumptions
 * are made explicit and checked, so a hostile machine produces a clear
 * environmental diagnostic instead of a mystery failure or a false pass.
 */

/**
 * Environment variables that retarget Git's own discovery. A layout reached
 * through any of these is outside what classification supports at all, so these
 * fixtures decline to run rather than report results from a configuration the
 * product does not describe.
 *
 * Configuration-*location* variables (`GIT_CONFIG_GLOBAL` and friends) are
 * deliberately absent: CI legitimately points them at an isolation file, their
 * presence says nothing about the layout, and banning them would not remove
 * configuration influence anyway.
 */
const DISCOVERY_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_INDEX_FILE',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
] as const;

/** The entries whose two-of-three presence makes a directory recognizably a bare git directory. */
const SIGNATURE_ENTRIES = ['HEAD', 'objects', 'refs'] as const;

export interface FixtureWorkspace {
  /** A realpath-canonical temporary directory that fixtures are built beneath. */
  readonly root: string;
  /** Creates an empty directory under the workspace and returns its path. */
  readonly directory: (name: string) => string;
  /** Runs `git` with fixture-only isolation applied. Never used for code under test. */
  readonly git: (cwd: string, args: readonly string[]) => string;
  readonly cleanup: () => void;
}

/**
 * Fails loudly rather than skipping. These are required integration tests: a
 * machine without git must report that, not quietly shrink the suite.
 */
export function requireGit(): string {
  try {
    return execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(
      'Git classification fixtures require a launchable `git` on PATH. ' +
        `Could not run \`git --version\`: ${String(error)}`,
      { cause: error },
    );
  }
}

export function createFixtureWorkspace(label: string): FixtureWorkspace {
  requireGit();
  assertNoDiscoveryOverrides();

  const root = realpathSync(mkdtempSync(join(tmpdir(), `isagi-git-${label}-`)));
  const isolation = realpathSync(mkdtempSync(join(tmpdir(), `isagi-git-${label}-cfg-`)));
  const globalConfig = join(isolation, 'gitconfig-global');
  const systemConfig = join(isolation, 'gitconfig-system');
  const hooksDirectory = join(isolation, 'hooks');
  writeFileSync(globalConfig, '');
  writeFileSync(systemConfig, '');
  mkdirSync(hooksDirectory);

  // The isolation files live outside `root` so they never appear in a tree that
  // classification walks.
  const childEnvironment = fixtureEnvironment(globalConfig, systemConfig);
  const controls = [
    '-c',
    'user.name=Isagi Fixture',
    '-c',
    'user.email=fixture@isagi.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    `core.hooksPath=${hooksDirectory}`,
    '-c',
    'init.defaultBranch=main',
  ];

  const git = (cwd: string, args: readonly string[]) =>
    execFileSync('git', [...controls, ...args], {
      cwd,
      encoding: 'utf8',
      env: childEnvironment,
    });

  assertAncestorsFreeOfGitMetadata(root);
  assertBaselineGitBehavior(root, git);

  return {
    root,
    directory: (name) => {
      const path = join(root, name);
      mkdirSync(path, { recursive: true });
      return path;
    },
    git,
    cleanup: () => {
      removeTree(root);
      removeTree(isolation);
    },
  };
}

/**
 * Strips every inherited `GIT_*` variable before supplying the intended
 * controls, so a developer's ambient Git settings cannot change what a fixture
 * repository looks like. This applies to fixture *construction* only — the
 * classifier under test runs exactly as it ships, against the real process
 * environment.
 */
function fixtureEnvironment(globalConfig: string, systemConfig: string) {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_')) {
      environment[key] = value;
    }
  }
  environment.GIT_CONFIG_GLOBAL = globalConfig;
  environment.GIT_CONFIG_SYSTEM = systemConfig;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function assertNoDiscoveryOverrides() {
  const present = DISCOVERY_OVERRIDES.filter((name) => process.env[name] !== undefined);
  if (present.length > 0) {
    throw new Error(
      `Git classification fixtures need an unredirected Git environment, but ${present.join(', ')} ` +
        'is set in this process. Classification does not support environment-directed layouts, so ' +
        'results here would describe a configuration the product does not implement. Unset it and rerun.',
    );
  }
}

/**
 * A precondition guard, not a correctness oracle. It re-states the rule the
 * classifier applies, so it shares that rule's assumptions and cannot validate
 * it; what it catches is a host whose temporary directory sits beneath stray Git
 * metadata, which would make ordinary-folder fixtures refuse for a reason that
 * has nothing to do with the code under test. Correctness evidence comes from
 * the deliberately constructed layouts and their expected outcomes.
 *
 * Deliberately not a call into `git-metadata.ts`: a guard that fails whenever
 * the code it guards fails would hide exactly the failures it exists to isolate.
 */
function assertAncestorsFreeOfGitMetadata(root: string) {
  let directory = root;
  for (;;) {
    if (entryExists(join(directory, '.git'))) {
      throw new Error(
        `Git classification fixtures require ${root} to have no Git metadata above it, but ` +
          `${join(directory, '.git')} exists. Ordinary-folder fixtures would be refused.`,
      );
    }
    const signature = SIGNATURE_ENTRIES.filter((entry) => entryExists(join(directory, entry)));
    if (signature.length >= 2) {
      throw new Error(
        `Git classification fixtures require ${root} to have no Git metadata above it, but ` +
          `${directory} contains ${signature.join(' and ')}, which reads as a bare git directory.`,
      );
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return;
    }
    directory = parent;
  }
}

/**
 * Confirms the host actually produces the answers the fixtures are built on:
 * an ordinary directory must draw the ordinary negative diagnostic, and a real
 * repository must be recognized. Without this, an environment that refuses every
 * path for an unrelated reason could make refusal-shaped assertions pass.
 */
function assertBaselineGitBehavior(
  root: string,
  git: (cwd: string, args: readonly string[]) => string,
) {
  const ordinary = join(root, '.baseline-ordinary');
  mkdirSync(ordinary);
  let negative: { status: number | null; stderr: string };
  try {
    git(ordinary, ['rev-parse', '--is-bare-repository']);
    negative = { status: 0, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number | null; stderr?: string };
    negative = { status: failure.status ?? null, stderr: failure.stderr ?? '' };
  }
  if (negative.status !== 128 || !/not a git repository/i.test(negative.stderr)) {
    throw new Error(
      `Git classification fixtures expect an ordinary directory to draw exit 128 and the ` +
        `"not a git repository" diagnostic, but ${ordinary} gave status ${String(negative.status)} ` +
        `and stderr ${JSON.stringify(negative.stderr)}.`,
    );
  }
  rmSync(ordinary, { recursive: true, force: true });

  const repository = join(root, '.baseline-repository');
  mkdirSync(repository);
  git(repository, ['init']);
  const bare = git(repository, ['rev-parse', '--is-bare-repository']).trim();
  const toplevel = git(repository, ['rev-parse', '--show-toplevel']).trim();
  if (bare !== 'false' || realpathSync(toplevel) !== repository) {
    throw new Error(
      `Git classification fixtures expect \`git init\` to produce a non-bare repository rooted at ` +
        `${repository}, but got bare=${bare} toplevel=${toplevel}.`,
    );
  }
  rmSync(repository, { recursive: true, force: true });
}

function entryExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent, and restores traversal permission first: a fixture that made a
 * directory unreadable would otherwise defeat its own removal and leave the
 * shared test process tripping over it in later files.
 */
export function removeTree(path: string) {
  try {
    chmodSync(path, 0o700);
  } catch {
    // The tree may already be gone, or never have had its permissions changed.
  }
  rmSync(path, { recursive: true, force: true });
}
