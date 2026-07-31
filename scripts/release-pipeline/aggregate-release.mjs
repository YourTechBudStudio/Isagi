#!/usr/bin/env node

import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { mergeMacMetadataDirectories } from '../../apps/desktop/scripts/merge-macos-update-metadata.mjs';

const platformFiles = Object.freeze({
  linux: {
    optional: [],
    required: ['Isagi-linux-x86_64.AppImage', 'install-isagi-linux.sh', 'latest-linux.yml'],
  },
  'mac-arm64': {
    optional: ['Isagi-mac-arm64.dmg.blockmap', 'Isagi-mac-arm64.zip.blockmap'],
    required: ['Isagi-mac-arm64.dmg', 'Isagi-mac-arm64.zip', 'latest-mac.yml'],
  },
  'mac-x64': {
    optional: ['Isagi-mac-x64.dmg.blockmap', 'Isagi-mac-x64.zip.blockmap'],
    required: ['Isagi-mac-x64.dmg', 'Isagi-mac-x64.zip', 'latest-mac.yml'],
  },
});

export function aggregateRelease(options) {
  const inputs = [
    ['linux', resolve(options.linuxDirectory)],
    ['mac-x64', resolve(options.macX64Directory)],
    ['mac-arm64', resolve(options.macArm64Directory)],
  ].map(([platform, directory]) => [directory, validatePlatformDirectory(directory, platform)]);
  const output = resolve(options.outputDirectory);
  rmSync(output, { force: true, recursive: true });
  mkdirSync(output, { recursive: true });
  for (const [directory, names] of inputs) {
    for (const name of names) {
      if (name !== 'latest-mac.yml') copyFileSync(resolve(directory, name), resolve(output, name));
    }
  }
  mergeMacMetadataDirectories({
    arm64Directory: resolve(options.macArm64Directory),
    outputPath: resolve(output, 'latest-mac.yml'),
    version: options.version,
    x64Directory: resolve(options.macX64Directory),
  });
  return readdirSync(output).sort();
}

export function validatePlatformDirectory(directory, platform) {
  const contract = platformFiles[platform];
  if (!contract) throw new Error(`Unsupported release platform ${platform}.`);
  const allowed = new Set([...contract.required, ...contract.optional]);
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!allowed.has(entry.name)) {
      throw new Error(`${platform} artifact contains unexpected entry ${entry.name}.`);
    }
    if (!entry.isFile() || lstatSync(resolve(directory, entry.name)).isSymbolicLink()) {
      throw new Error(`${platform} artifact entry ${entry.name} is not a regular file.`);
    }
  }
  const names = new Set(entries.map((entry) => entry.name));
  for (const name of contract.required) {
    if (!names.has(name)) throw new Error(`${platform} artifact is missing ${name}.`);
  }
  return [...names].sort();
}

function parseArguments(args) {
  const values = {};
  const flags = new Set(['linux', 'mac-x64', 'mac-arm64', 'output', 'version']);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]?.replace(/^--/u, '');
    const value = args[index + 1];
    if (!flags.has(flag) || value === undefined || flag in values) throw new Error(usage());
    values[flag] = value;
  }
  for (const flag of flags) if (!(flag in values)) throw new Error(usage());
  return {
    linuxDirectory: values.linux,
    macArm64Directory: values['mac-arm64'],
    macX64Directory: values['mac-x64'],
    outputDirectory: values.output,
    version: values.version,
  };
}

function usage() {
  return 'Usage: aggregate-release --linux DIR --mac-x64 DIR --mac-arm64 DIR --output DIR --version VERSION';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assets = aggregateRelease(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify({ assetCount: assets.length, assets }));
}
