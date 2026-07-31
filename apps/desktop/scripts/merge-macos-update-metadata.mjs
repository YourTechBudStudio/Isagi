import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  mergeMacUpdateMetadata,
  serializeMacUpdateYaml,
  verifyMacArchitectureMetadata,
} from './macos-update-metadata.mjs';

export function mergeMacMetadataDirectories({ arm64Directory, outputPath, version, x64Directory }) {
  const inputs = Object.fromEntries(
    [
      ['x64', x64Directory],
      ['arm64', arm64Directory],
    ].map(([architecture, directory]) => [
      architecture,
      verifyMacArchitectureMetadata({
        architecture,
        contents: readMetadata(directory),
        directory,
        version,
      }),
    ]),
  );
  const serialized = serializeMacUpdateYaml(mergeMacUpdateMetadata(inputs));
  const destination = resolve(outputPath);
  const temporary = resolve(dirname(destination), `.${Date.now()}-${process.pid}-latest-mac.yml`);
  writeFileSync(temporary, serialized, { flag: 'wx' });
  renameSync(temporary, destination);
  return { contents: serialized, outputPath: destination };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  mergeMacMetadataDirectories(options);
  console.log(`[desktop] Merged macOS update metadata at ${resolve(options.outputPath)}`);
}

function readMetadata(directory) {
  return readFileSync(resolve(directory, 'latest-mac.yml'), 'utf8');
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--x64', '--arm64', '--output', '--version'].includes(flag) || value === undefined) {
      throw new Error(
        'Usage: merge:mac-metadata --x64 DIR --arm64 DIR --output FILE --version VERSION',
      );
    }
    if (flag.slice(2) in values) throw new Error(`Duplicate argument ${flag}.`);
    values[flag.slice(2)] = value;
  }
  for (const key of ['x64', 'arm64', 'output', 'version']) {
    if (!(key in values)) throw new Error(`Missing --${key}.`);
  }
  return {
    arm64Directory: values.arm64,
    outputPath: values.output,
    version: values.version,
    x64Directory: values.x64,
  };
}
