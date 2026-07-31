import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';

import { desktopLicenseBundle } from './desktop-license-bundle.mjs';
import {
  classifyCommandFailure,
  parseCodesignDetails,
  parseEntitlements,
  verifyBundleVersions,
  verifyMacIconAsset,
  verifyMacRelease,
  withMountedDmg,
} from './verify-macos-release.mjs';

test('codesign details distinguish Developer ID authority and actual TeamIdentifier', () => {
  assert.deepEqual(
    parseCodesignDetails(`Executable=/Applications/Isagi.app/Contents/MacOS/Isagi
Identifier=studio.yourtechbud.isagi
Authority=Developer ID Application: Your Tech Bud Studio (TEAM123456)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=TEAM123456
Runtime Version=26.0.0
`),
    {
      authorities: [
        'Developer ID Application: Your Tech Bud Studio (TEAM123456)',
        'Developer ID Certification Authority',
        'Apple Root CA',
      ],
      teamIdentifier: 'TEAM123456',
    },
  );
});

test('entitlement parsing reads only the entitlement plist key/value pairs', () => {
  const output = `Executable=/tmp/Isagi
TeamIdentifier=TEAM123456
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
</dict></plist>`;
  assert.deepEqual(parseEntitlements(output), {
    'com.apple.security.cs.allow-jit': true,
  });
  assert.deepEqual(
    parseEntitlements(
      '<dict><key>com.apple.security.cs.disable-library-validation</key><false/></dict>',
    ),
    { 'com.apple.security.cs.disable-library-validation': false },
  );
});

test('command failure classification retains the failed check without environment data', () => {
  assert.equal(
    classifyCommandFailure('codesign', ['--verify', '/tmp/Isagi.app'], {
      code: 1,
      signal: null,
      stderr: 'invalid signature',
      stdout: '',
    }),
    'codesign --verify /tmp/Isagi.app failed with exit 1: invalid signature',
  );
});

test('bundle versions must both equal the canonical release version', () => {
  const valid = { CFBundleShortVersionString: '1.2.3', CFBundleVersion: '1.2.3' };
  assert.doesNotThrow(() => verifyBundleVersions(valid, '1.2.3', 'test app'));
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    assert.throws(
      () => verifyBundleVersions({ ...valid, [key]: '1.2.4' }, '1.2.3', 'test app'),
      new RegExp(`${key} is 1\\.2\\.4, expected 1\\.2\\.3`, 'u'),
    );
    const missing = { ...valid };
    delete missing[key];
    assert.throws(
      () => verifyBundleVersions(missing, '1.2.3', 'test app'),
      new RegExp(`${key} is missing, expected 1\\.2\\.3`, 'u'),
    );
  }
});

test('macOS icon verification rejects an asset that differs from the canonical ICNS', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-mac-icon-'));
  const icon = resolve(root, 'icon.icns');
  try {
    copyFileSync(resolve(import.meta.dirname, '../assets/app-icon.icns'), icon);
    assert.doesNotThrow(() => verifyMacIconAsset(icon, 'test app'));
    writeFileSync(icon, 'corrupted icon');
    assert.throws(
      () => verifyMacIconAsset(icon, 'test app'),
      /test app icon does not match the canonical macOS icon asset/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('DMG acquisition releases successfully after successful verification', async () => {
  const lifecycle = createMountLifecycle();
  const result = await Effect.runPromise(
    withMountedDmg(lifecycle.options, () =>
      Effect.sync(() => {
        lifecycle.events.push('use');
        return 'verified';
      }),
    ),
  );
  assert.equal(result, 'verified');
  assert.deepEqual(lifecycle.events, ['attach', 'use', 'detach']);
  assert.equal(lifecycle.detachFailed(), false);
});

test('DMG acquisition preserves verification failure after successful cleanup', async () => {
  const verificationFailure = new Error('verification failed');
  const lifecycle = createMountLifecycle();
  const exit = await Effect.runPromiseExit(
    withMountedDmg(lifecycle.options, () =>
      Effect.suspend(() => {
        lifecycle.events.push('use');
        return Effect.fail(verificationFailure);
      }),
    ),
  );
  assert.deepEqual(causeErrors(exit), [verificationFailure]);
  assert.deepEqual(lifecycle.events, ['attach', 'use', 'detach']);
  assert.equal(lifecycle.detachFailed(), false);
});

test('DMG acquisition exposes cleanup-only failure and marks the mount root unsafe', async () => {
  const detachFailure = new Error('detach failed');
  const lifecycle = createMountLifecycle({ detachFailure });
  const exit = await Effect.runPromiseExit(
    withMountedDmg(lifecycle.options, () => Effect.sync(() => lifecycle.events.push('use'))),
  );
  assert.deepEqual(causeErrors(exit), [detachFailure]);
  assert.deepEqual(lifecycle.events, ['attach', 'use', 'detach']);
  assert.equal(lifecycle.detachFailed(), true);
});

test('DMG acquisition reports verification and cleanup failures together', async () => {
  const verificationFailure = new Error('verification failed');
  const detachFailure = new Error('detach failed');
  const lifecycle = createMountLifecycle({ detachFailure });
  const exit = await Effect.runPromiseExit(
    withMountedDmg(lifecycle.options, () =>
      Effect.suspend(() => {
        lifecycle.events.push('use');
        return Effect.fail(verificationFailure);
      }),
    ),
  );
  assert.deepEqual(causeErrors(exit), [verificationFailure, detachFailure]);
  assert.deepEqual(lifecycle.events, ['attach', 'use', 'detach']);
  assert.equal(lifecycle.detachFailed(), true);
});

test('DMG acquisition rejects a mount outside the predetermined path and still detaches', async () => {
  const lifecycle = createMountLifecycle({ returnedMountPoint: '/private/tmp/unexpected' });
  const exit = await Effect.runPromiseExit(withMountedDmg(lifecycle.options, () => Effect.void));
  assert.match(causeErrors(exit)[0].message, /expected predetermined path/u);
  assert.deepEqual(lifecycle.events, ['attach', 'detach']);
});

test('DMG acquisition detaches when the surrounding fiber is interrupted', async () => {
  const lifecycle = createMountLifecycle();
  const mounted = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make();
      const fiber = yield* Effect.fork(
        withMountedDmg(lifecycle.options, () =>
          Effect.gen(function* () {
            lifecycle.events.push('use');
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        ),
      );
      yield* Deferred.await(started);
      return yield* Fiber.interrupt(fiber);
    }),
  );
  assert.equal(Exit.isInterrupted(mounted), true);
  assert.deepEqual(lifecycle.events, ['attach', 'use', 'detach']);
});

test('macOS verifier drives the complete app, ZIP, and DMG command contract through an injected runner', async () => {
  const fixture = createReleaseFixture();
  try {
    const commands = [];
    const result = await Effect.runPromise(
      verifyMacRelease({
        allowNonDarwin: true,
        architecture: 'arm64',
        expectedTeamId: 'TEAM123456',
        expectedVersion: '1.2.3',
        releaseDirectory: fixture.release,
        run: (command, args) =>
          Effect.sync(() => {
            commands.push([command, ...args]);
            return fakeCommand(fixture, command, args);
          }),
        smoke: false,
      }),
    );
    assert.equal(result.architecture, 'arm64');
    assert.equal(result.artifactCount, 4);
    assert.equal(result.licenseFileCount, desktopLicenseBundle.files.length);
    assert.equal(result.nativePayloadCount >= 4, true);
    for (const expected of [
      ['ditto', '-x', '-k'],
      ['hdiutil', 'attach'],
      ['hdiutil', 'detach'],
      ['xcrun', 'stapler', 'validate'],
      ['spctl', '--assess', '--type', 'execute'],
      ['codesign', '--verify', '--deep', '--strict'],
      ['codesign', '--display', '--entitlements', ':-'],
      ['lipo', '-archs'],
      ['iconutil', '-c', 'iconset'],
    ]) {
      assert.equal(
        commands.some((actual) => expected.every((value, index) => actual[index] === value)),
        true,
        `missing ${expected.join(' ')}`,
      );
    }
    assert.equal(
      commands.some(
        (actual) =>
          actual[0] === 'xcrun' && actual[1] === 'stapler' && actual.at(-1).endsWith('.dmg'),
      ),
      false,
    );
    assert.equal(
      commands.some((actual) => actual.includes('open')),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

function createReleaseFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'isagi-mac-verifier-'));
  const release = resolve(root, 'release');
  const unpacked = resolve(release, 'mac-arm64/Isagi.app');
  mkdirSync(release, { recursive: true });
  createApp(unpacked);
  const records = {};
  for (const extension of ['zip', 'dmg']) {
    const name = `Isagi-mac-arm64.${extension}`;
    const bytes = Buffer.from(`signed-${extension}`);
    writeFileSync(resolve(release, name), bytes);
    writeFileSync(resolve(release, `${name}.blockmap`), Buffer.alloc(42));
    records[extension] = {
      name,
      sha512: createHash('sha512').update(bytes).digest('base64'),
      size: bytes.length,
    };
  }
  writeFileSync(
    resolve(release, 'latest-mac.yml'),
    `version: 1.2.3
files:
  - url: ${records.zip.name}
    sha512: ${records.zip.sha512}
    size: ${records.zip.size}
    blockMapSize: 42
  - url: ${records.dmg.name}
    sha512: ${records.dmg.sha512}
    size: ${records.dmg.size}
    blockMapSize: 42
path: ${records.zip.name}
sha512: ${records.zip.sha512}
releaseDate: '2026-07-30T00:00:00.000Z'
`,
  );
  return {
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    release,
    unpacked,
  };
}

function createApp(app) {
  const main = resolve(app, 'Contents/MacOS/Isagi');
  const helper = resolve(app, 'Contents/Frameworks/Isagi Helper.app/Contents/MacOS/Isagi Helper');
  const resources = resolve(app, 'Contents/Resources');
  const runtime = resolve(resources, 'runtime');
  const nativeRoot = resolve(runtime, 'node_modules/native');
  for (const directory of [resolve(main, '..'), resolve(helper, '..'), nativeRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const path of [
    main,
    helper,
    resolve(nativeRoot, 'binding.node'),
    resolve(nativeRoot, 'spawn-helper'),
  ]) {
    writeFileSync(path, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  }
  writeFileSync(
    resolve(app, 'Contents/Info.plist'),
    '<plist><dict><key>CFBundleIdentifier</key><string>studio.yourtechbud.isagi</string><key>CFBundleShortVersionString</key><string>1.2.3</string><key>CFBundleVersion</key><string>1.2.3</string></dict></plist>',
  );
  copyFileSync(
    resolve(import.meta.dirname, '../assets/app-icon.icns'),
    resolve(resources, 'AppIcon.icns'),
  );
  writeFileSync(
    resolve(runtime, 'runtime-stage.json'),
    JSON.stringify({ electron: { arch: 'arm64', platform: 'darwin' } }),
  );
  writeFileSync(
    resolve(resources, 'app-update.yml'),
    'provider: github\nowner: YourTechBudStudio\nrepo: Isagi\n',
  );
  const licenses = resolve(resources, desktopLicenseBundle.directoryName);
  mkdirSync(licenses);
  for (const file of desktopLicenseBundle.files) {
    copyFileSync(file.sourcePath, resolve(licenses, file.name));
  }
}

function fakeCommand(fixture, command, args) {
  if (command === 'mkdir') mkdirSync(args[0], { recursive: true });
  if (command === 'ditto')
    cpSync(fixture.unpacked, resolve(args.at(-1), 'Isagi.app'), { recursive: true });
  if (command === 'iconutil') {
    const output = args[args.indexOf('-o') + 1];
    mkdirSync(output);
    for (const name of [
      'icon_16x16.png',
      'icon_16x16@2x.png',
      'icon_128x128.png',
      'icon_128x128@2x.png',
      'icon_256x256@2x.png',
      'icon_512x512@2x.png',
    ]) {
      writeFileSync(resolve(output, name), 'png');
    }
  }
  if (command === 'plutil') {
    return success(
      JSON.stringify({
        CFBundleExecutable: 'Isagi',
        CFBundleIconFile: 'AppIcon.icns',
        CFBundleIdentifier: 'studio.yourtechbud.isagi',
        CFBundleShortVersionString: '1.2.3',
        CFBundleVersion: '1.2.3',
      }),
    );
  }
  if (command === 'lipo') return success('arm64\n');
  if (command === 'hdiutil' && args[0] === 'attach') {
    const mountPoint = args[args.indexOf('-mountpoint') + 1];
    cpSync(fixture.unpacked, resolve(mountPoint, 'Isagi.app'), { recursive: true });
    symlinkSync('/Applications', resolve(mountPoint, 'Applications'));
    return success(
      `<plist><dict><key>mount-point</key><string>${mountPoint}</string></dict></plist>`,
    );
  }
  if (command === 'codesign' && args.includes('--entitlements')) {
    return success(
      '',
      '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>',
    );
  }
  if (command === 'codesign' && args.includes('--display')) {
    return success(
      '',
      'Authority=Developer ID Application: Your Tech Bud Studio (TEAM123456)\nTeamIdentifier=TEAM123456\n',
    );
  }
  return success();
}

function createMountLifecycle(options = {}) {
  const events = [];
  let detachFailed = false;
  const mountPoint = '/private/tmp/isagi-mount';
  return {
    detachFailed: () => detachFailed,
    events,
    options: {
      dmgPath: '/tmp/Isagi.dmg',
      mountPoint,
      onDetachFailure: () => (detachFailed = true),
      run: (_command, args) =>
        Effect.suspend(() => {
          if (args[0] === 'attach') {
            events.push('attach');
            return Effect.succeed(
              success(
                `<plist><dict><key>mount-point</key><string>${options.returnedMountPoint ?? mountPoint}</string></dict></plist>`,
              ),
            );
          }
          events.push('detach');
          return options.detachFailure
            ? Effect.fail(options.detachFailure)
            : Effect.succeed(success());
        }),
    },
  };
}

// Detachment fails as a defect so it stays visible next to any verification
// failure, so both channels are flattened into one ordered list.
function causeErrors(exit) {
  if (Exit.isSuccess(exit)) return [];
  return [...Cause.failures(exit.cause), ...Cause.defects(exit.cause)];
}

function success(stdout = '', stderr = '') {
  return { code: 0, signal: null, stderr, stdout };
}
