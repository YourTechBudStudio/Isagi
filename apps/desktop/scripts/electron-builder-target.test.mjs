import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  classifyPackagingRequest,
  parseBuilderArguments,
  unsupportedPackagingMessage,
} from './electron-builder-target.mjs';

const distArguments = ['--publish', 'never'];
const distLinuxArguments = ['--linux', 'AppImage', '--x64', '--publish', 'never'];
const packDirArguments = ['--dir', '--publish', 'never'];

// Every invocation must carry the required policy, so target and architecture
// cases append it rather than restating it.
const withPolicy = (...args) => [...args, '--publish', 'never'];

test('builder argument parsing reads platforms, architectures, targets, and publish policies', () => {
  const linux = parseBuilderArguments(distLinuxArguments);
  assert.deepEqual([...linux.targetsByPlatform], [['linux', ['AppImage']]]);
  assert.deepEqual(linux.architectures, ['x64']);
  assert.deepEqual(linux.publishPolicies, ['never']);
  assert.equal(linux.dir, false);

  // `never` belongs to --publish, not to the --linux target list.
  const implicitTarget = parseBuilderArguments(withPolicy('--linux'));
  assert.deepEqual([...implicitTarget.targetsByPlatform], [['linux', []]]);

  const generic = parseBuilderArguments(distArguments);
  assert.deepEqual([...generic.targetsByPlatform], []);
  assert.deepEqual(generic.architectures, []);

  assert.equal(parseBuilderArguments(packDirArguments).dir, true);
  assert.deepEqual(
    [...parseBuilderArguments(withPolicy('--linux', 'deb', 'AppImage')).targetsByPlatform],
    [['linux', ['deb', 'AppImage']]],
  );
  assert.deepEqual(
    parseBuilderArguments(['--publish', 'always', '--publish', 'never']).publishPolicies,
    ['always', 'never'],
  );

  // Every supported spelling parses cleanly; anything else is collected instead.
  for (const args of [distArguments, distLinuxArguments, packDirArguments, withPolicy('--linux')]) {
    assert.deepEqual(parseBuilderArguments(args).unrecognized, [], args.join(' '));
  }
  assert.deepEqual(parseBuilderArguments(['-mwl', '--linux=deb']).unrecognized, [
    '-mwl',
    '--linux=deb',
  ]);
});

test('packaging classification follows the produced artifact, not the argument spelling', () => {
  // The canonical entry point and the generic one both produce the configured
  // linux/x64 AppImage, so both must stage the installer and verify.
  for (const args of [
    distLinuxArguments,
    distArguments,
    withPolicy('--linux', '--x64'),
    withPolicy('--x64', '--linux', 'AppImage'),
  ]) {
    assert.deepEqual(
      classifyPackagingRequest(args, 'linux'),
      { kind: 'linux-release' },
      `expected a Linux release for ${args.join(' ')}`,
    );
  }
  // The configuration pins the Linux artifact to x64, so the host architecture
  // is not an input at all and a Linux host of any architecture still resolves
  // to the one shipped artifact.
  assert.deepEqual(classifyPackagingRequest(withPolicy('--linux', '--x64'), 'darwin'), {
    kind: 'linux-release',
  });
});

test('non-Linux and unpacked packaging are not Linux distribution decisions', () => {
  assert.deepEqual(classifyPackagingRequest(distArguments, 'darwin'), { kind: 'other' });
  assert.deepEqual(classifyPackagingRequest(distArguments, 'win32'), { kind: 'other' });
  assert.deepEqual(classifyPackagingRequest(withPolicy('--mac', '--arm64'), 'linux'), {
    kind: 'other',
  });
  // `--dir` is unpacked packaging; electron-builder ignores target selection for it.
  for (const args of [
    packDirArguments,
    withPolicy('--linux', 'AppImage', '--dir'),
    withPolicy('--linux', 'deb', '--dir'),
  ]) {
    assert.deepEqual(classifyPackagingRequest(args, 'linux'), { kind: 'other' });
  }
});

const reject = (args, platform = 'linux') => {
  const request = classifyPackagingRequest(args, platform);
  assert.equal(request.kind, 'unsupported', `expected rejection for ${args.join(' ')}`);
  assert.equal(typeof request.reason, 'string');
  assert.notEqual(request.reason, '');
  return request.reason;
};

test('any request that could publish before verification is refused', () => {
  // electron-builder schedules uploads as artifacts are created, and Isagi
  // verifies only after the build returns, so a publishing policy inverts the
  // required order and no later failure can retract the upload.
  for (const policy of ['always', 'onTag', 'onTagOrDraft']) {
    assert.match(
      reject(['--linux', 'AppImage', '--x64', '--publish', policy]),
      new RegExp(`--publish ${policy} would upload artifacts before Isagi verifies them`, 'u'),
    );
    assert.match(reject(['--publish', policy], 'darwin'), /only never is accepted/u);
    assert.match(reject(['--dir', '--publish', policy]), /only never is accepted/u);
  }

  // An omitted policy is not safe: electron-builder publishes implicitly under
  // an npm release lifecycle event, on a git tag, or on CI detection.
  for (const args of [[], ['--linux', 'AppImage', '--x64'], ['--dir'], ['--mac']]) {
    assert.match(reject(args), /missing --publish never; electron-builder publishes implicitly/u);
  }

  // Duplicates are ambiguous regardless of order, including when one is `never`.
  for (const args of [
    ['--publish', 'never', '--publish', 'never'],
    ['--publish', 'never', '--publish', 'always'],
    ['--publish', 'always', '--publish', 'never'],
    ['--linux', 'AppImage', '--publish', 'onTag', '--publish', 'never'],
  ]) {
    assert.match(reject(args), /--publish was given 2 times/u);
  }
});

test('every unsupported Linux distribution request fails loudly instead of skipping verification', () => {
  // Single and multi-target selections that are not exactly AppImage.
  assert.match(reject(withPolicy('--linux', 'deb')), /deb is not AppImage/u);
  assert.match(reject(withPolicy('--linux', 'AppImage', 'deb')), /AppImage, deb is not AppImage/u);
  assert.match(reject(withPolicy('--linux', 'deb', 'AppImage')), /deb, AppImage is not AppImage/u);
  assert.match(reject(withPolicy('--linux', 'snap', '--x64')), /snap/u);
  assert.match(reject(withPolicy('--linux', 'tar.gz')), /tar\.gz/u);

  // Architectures Isagi does not distribute, explicitly requested.
  assert.match(reject(withPolicy('--linux', '--arm64')), /Linux arm64 is not a supported/u);
  assert.match(reject(withPolicy('--linux', 'AppImage', '--armv7l')), /armv7l/u);
  assert.match(reject(withPolicy('--linux', 'AppImage', '--ia32')), /ia32/u);
  assert.match(reject(withPolicy('--linux', '--universal')), /Linux universal is not a supported/u);

  // Conflicting or ambiguous selections.
  assert.match(reject(withPolicy('--x64', '--arm64')), /conflicting architecture/u);
  assert.match(reject(withPolicy('--linux', 'AppImage', '--x64', '--arm64')), /conflicting/u);
  assert.match(reject(withPolicy('--linux', '--mac'), 'darwin'), /together with darwin/u);
  assert.match(reject(withPolicy('--linux', 'AppImage', '--win', 'nsis')), /together with win32/u);
});

test('alternative electron-builder spellings are refused rather than interpreted', () => {
  // yargs accepts equals-form, short-form, and combined flags. Interpreting them
  // here would mean maintaining a second grammar free to disagree with the real
  // one, and every disagreement is a route to an unverified Linux artifact. Each
  // of these is rejected on every host, including hosts where the spelling would
  // otherwise read as an unrelated or absent platform selection.
  for (const args of [
    withPolicy('--linux=AppImage'),
    withPolicy('--linux=deb'),
    withPolicy('-l=AppImage'),
    withPolicy('--linux=AppImage', '--arm64=true'),
    withPolicy('-mwl'),
    withPolicy('--x64=true', '--linux'),
    withPolicy('--mac=dmg', '--linux=AppImage'),
    ['--linux', 'AppImage', '--publish=never'],
    withPolicy('--linux', 'AppImage', '--config', 'other.yml'),
    withPolicy('AppImage'),
    ['--linux', 'AppImage', '--publish'],
    ['--linux', 'AppImage', '--publish', 'sometimes'],
    // Short aliases electron-builder accepts are outside the documented grammar.
    withPolicy('-l', 'AppImage'),
    withPolicy('-m'),
    withPolicy('-w'),
    withPolicy('--macos'),
    withPolicy('--windows'),
    ['--linux', 'AppImage', '-p', 'never'],
  ]) {
    for (const platform of ['linux', 'darwin', 'win32']) {
      assert.match(
        reject(args, platform),
        /unrecognized packaging arguments/u,
        `expected ${args.join(' ')} to be refused on ${platform}`,
      );
    }
  }
});

test('the unsupported-request message names the shipped artifact and the supported commands', () => {
  const message = unsupportedPackagingMessage('Linux target selection deb is not AppImage');
  assert.match(message, /Unsupported packaging request/u);
  assert.match(message, /deb is not AppImage/u);
  assert.match(message, /x64 AppImage/u);
  assert.match(message, /pnpm package:desktop:linux/u);
});

test('packaging scripts route through the single verified entry point and never publish', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
  );
  for (const script of ['dist', 'dist:linux', 'pack:dir']) {
    const command = manifest.scripts[script];
    assert.equal(command.startsWith('node scripts/run-electron-builder.mjs'), true);
    assert.equal(command.endsWith('--publish never'), true, `${script} must pin --publish never`);
  }
  // Every shipped script must classify as something the wrapper accepts.
  for (const [script, platform] of [
    ['dist', 'linux'],
    ['dist', 'darwin'],
    ['dist:linux', 'darwin'],
    ['pack:dir', 'linux'],
  ]) {
    const args = manifest.scripts[script].split(' ').slice(2);
    assert.notEqual(classifyPackagingRequest(args, platform).kind, 'unsupported');
  }
});
