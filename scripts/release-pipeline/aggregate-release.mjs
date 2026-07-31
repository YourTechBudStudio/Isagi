#!/usr/bin/env node

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { mergeMacMetadataDirectories } from '../../apps/desktop/scripts/merge-macos-update-metadata.mjs';
import {
  createReleaseManifest,
  releaseManifestName,
  serializeReleaseManifest,
  validatePlatformDirectory,
} from './artifact-manifest.mjs';

export function aggregateRelease(options) {
  const platforms = [
    ['linux', resolve(options.linuxDirectory)],
    ['mac-x64', resolve(options.macX64Directory)],
    ['mac-arm64', resolve(options.macArm64Directory)],
  ];
  const validated = platforms.map(([platform, directory]) => [
    platform,
    directory,
    validatePlatformDirectory(directory, platform),
  ]);
  const output = resolve(options.outputDirectory);
  rmSync(output, { force: true, recursive: true });
  mkdirSync(output, { recursive: true });
  for (const [, directory, names] of validated) {
    for (const name of names) {
      if (name === 'latest-mac.yml') continue;
      copyFileSync(resolve(directory, name), resolve(output, name));
    }
  }
  mergeMacMetadataDirectories({
    arm64Directory: resolve(options.macArm64Directory),
    outputPath: resolve(output, 'latest-mac.yml'),
    version: options.version,
    x64Directory: resolve(options.macX64Directory),
  });
  const manifest = createReleaseManifest({
    commitSha: options.commitSha,
    directory: output,
    tag: options.tag,
    version: options.version,
  });
  writeFileSync(resolve(output, releaseManifestName), serializeReleaseManifest(manifest), {
    flag: 'wx',
  });
  return manifest;
}

function parseArguments(args) {
  const values = {};
  const flags = new Set(['linux', 'mac-x64', 'mac-arm64', 'output', 'version', 'tag', 'commit']);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]?.replace(/^--/u, '');
    const value = args[index + 1];
    if (!flags.has(flag) || value === undefined || flag in values) throw new Error(usage());
    values[flag] = value;
  }
  for (const flag of flags) if (!(flag in values)) throw new Error(usage());
  return {
    commitSha: values.commit,
    linuxDirectory: values.linux,
    macArm64Directory: values['mac-arm64'],
    macX64Directory: values['mac-x64'],
    outputDirectory: values.output,
    tag: values.tag,
    version: values.version,
  };
}

function usage() {
  return 'Usage: aggregate-release --linux DIR --mac-x64 DIR --mac-arm64 DIR --output DIR --version VERSION --tag TAG --commit SHA';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = aggregateRelease(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify({ assetCount: manifest.assets.length, version: manifest.version }));
}
