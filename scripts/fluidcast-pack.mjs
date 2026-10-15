#!/usr/bin/env node
// Packs the Fluidcast libraries Isagi consumes from the local checkout behind `.fluidcast` into
// `.fluidcast-packs/`, where the root `overrides` in `pnpm-workspace.yaml` install them from.
//
// Installing tarballs, rather than linking the checkout, makes pnpm resolve each package's peers
// (`effect` above all) from Isagi's own graph, so the runtime and web run one physical copy of each.
// `pnpm pack` also rewrites Fluidcast's `workspace:` and `catalog:` specifiers to concrete versions.
//
// After any Fluidcast change: `pnpm fluidcast:pack`, then `pnpm install`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checkout = join(root, '.fluidcast');
const destination = join(root, '.fluidcast-packs');

/** Every Fluidcast library Isagi installs; each must have an override in `pnpm-workspace.yaml`. */
export const fluidcastPackages = [
  'core',
  'harness',
  'presets',
  'tool-agent',
  'tool-ask',
  'tool-show',
  'client',
  'react',
];

/** The tarball `pnpm pack` writes for a package at `0.0.0`, which the overrides name. */
export const tarballName = (name) => `yourtechbudstudio-fluidcast-${name}-0.0.0.tgz`;

function run(args, cwd) {
  execFileSync('pnpm', args, { cwd, stdio: 'inherit' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(join(checkout, 'package.json'))) {
    console.error(
      `No Fluidcast checkout at ${checkout}. Create the link first: ln -s <path to Fluidcast> .fluidcast`,
    );
    process.exit(1);
  }

  run(['build:libs'], checkout);

  // Always exactly the current packs: a stale tarball must never be installed.
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const name of fluidcastPackages) {
    run(['pack', '--pack-destination', destination], join(checkout, 'packages', name));
  }

  const packed = readdirSync(destination).sort();
  const expected = fluidcastPackages.map(tarballName).sort();
  if (JSON.stringify(packed) !== JSON.stringify(expected)) {
    console.error(`Unexpected packs in ${destination}:\n  ${packed.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`\nPacked ${packed.length} Fluidcast libraries. Now run: pnpm install`);
}
