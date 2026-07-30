import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const installer = resolve(import.meta.dirname, 'install-isagi-linux.sh');
const iconSource = resolve(import.meta.dirname, '../assets/app-icon-linux.png');
const sizes = [16, 24, 32, 48, 64, 96, 128, 256, 512];

test('Linux installer installs and idempotently replaces the managed application under paths with reserved characters', async () => {
  const fixture = await createFixture('isagi installer $`%" ');
  try {
    const first = await runInstaller(fixture);
    assert.match(first.stdout, /Isagi installed at/u);
    const installedAppImage = resolve(fixture.dataHome, 'isagi/Isagi.AppImage');
    assert.equal((await lstat(installedAppImage)).mode & 0o777, 0o755);
    const desktopPath = resolve(fixture.dataHome, 'applications/studio.yourtechbud.isagi.desktop');
    const desktop = await readFile(desktopPath, 'utf8');
    assert.match(desktop, /^X-Isagi-Managed=true$/mu);
    assert.match(desktop, /^Icon=isagi$/mu);
    assert.match(desktop, /^Terminal=false$/mu);
    assert.match(desktop, /^StartupWMClass=studio\.yourtechbud\.isagi$/mu);
    const execLine = desktop.split(/\r?\n/u).find((line) => line.startsWith('Exec='));
    assert.equal(decodeDesktopExec(execLine), installedAppImage);
    for (const size of sizes) {
      assert.equal(
        (
          await lstat(resolve(fixture.dataHome, `icons/hicolor/${size}x${size}/apps/isagi.png`))
        ).isFile(),
        true,
      );
    }
    assert.equal(fixture.databaseInvocations(), 1);

    await writeFile(fixture.appImage, `${await readFile(fixture.appImage, 'utf8')}\n# updated\n`);
    await runInstaller(fixture);
    assert.match(await readFile(installedAppImage, 'utf8'), /# updated/u);
    assert.equal(fixture.databaseInvocations(), 2);
  } finally {
    await fixture.cleanup();
  }
});

test('Linux installer locates the AppImage beside itself and tolerates a missing desktop database command', async () => {
  const fixture = await createFixture('isagi-adjacent-');
  try {
    const adjacentInstaller = resolve(fixture.assetDirectory, 'install-isagi-linux.sh');
    const adjacentAppImage = resolve(fixture.assetDirectory, 'Isagi-linux-x86_64.AppImage');
    await writeFile(adjacentInstaller, await readFile(installer));
    await chmod(adjacentInstaller, 0o755);
    await writeFile(adjacentAppImage, await readFile(fixture.appImage));
    await chmod(adjacentAppImage, 0o644);
    await rm(resolve(fixture.binDirectory, 'update-desktop-database'));
    const result = await run('sh', [adjacentInstaller], fixture.environment);
    assert.match(result.stdout, /Isagi installed at/u);
  } finally {
    await fixture.cleanup();
  }
});

test('Linux installer rejects unsafe arguments, roots, paths, and managed targets', async (t) => {
  const fixture = await createFixture('isagi-rejections-');
  try {
    await t.test('extra argument', async () => {
      await assert.rejects(
        () => runInstaller(fixture, [fixture.appImage, 'extra']),
        /expected zero or one APPIMAGE/u,
      );
    });
    await t.test('relative XDG_DATA_HOME', async () => {
      await assert.rejects(
        () => runInstaller(fixture, [fixture.appImage], { XDG_DATA_HOME: 'relative' }),
        /must be an absolute path/u,
      );
    });
    await t.test('control character in XDG_DATA_HOME', async () => {
      await assert.rejects(
        () =>
          runInstaller(fixture, [fixture.appImage], { XDG_DATA_HOME: `${fixture.dataHome}\tbad` }),
        /cannot contain ASCII control characters/u,
      );
    });
    await t.test('control characters in source and destination inputs', async () => {
      await assert.rejects(
        () => runInstaller(fixture, [`${fixture.appImage}\u0001bad`]),
        /cannot contain ASCII control characters/u,
      );
      await assert.rejects(
        () =>
          runInstaller(fixture, [fixture.appImage], {
            XDG_DATA_HOME: `${fixture.dataHome}\u007fbad`,
          }),
        /cannot contain ASCII control characters/u,
      );
    });
    await t.test('equals sign in the installed executable path', async () => {
      await assert.rejects(
        () =>
          runInstaller(fixture, [fixture.appImage], { XDG_DATA_HOME: `${fixture.dataHome}=bad` }),
        /cannot contain an equals sign/u,
      );
    });
    await t.test('UID 0', async () => {
      const rootBin = resolve(fixture.root, 'root-bin');
      await mkdir(rootBin);
      await writeExecutable(resolve(rootBin, 'id'), '#!/bin/sh\nprintf "0\\n"\n');
      await assert.rejects(
        () =>
          runInstaller(fixture, [fixture.appImage], {
            PATH: `${rootBin}:${fixture.environment.PATH}`,
          }),
        /refusing to install as UID 0/u,
      );
    });
    await t.test('symlink source', async () => {
      const link = resolve(fixture.root, 'linked.AppImage');
      await symlink(fixture.appImage, link);
      await assert.rejects(() => runInstaller(fixture, [link]), /source AppImage is a symlink/u);
    });
    await t.test('unmanaged desktop entry', async () => {
      const applications = resolve(fixture.dataHome, 'applications');
      await mkdir(applications, { recursive: true });
      await writeFile(
        resolve(applications, 'studio.yourtechbud.isagi.desktop'),
        '[Desktop Entry]\nName=Someone else\n',
      );
      await assert.rejects(() => runInstaller(fixture), /application entry not managed by Isagi/u);
    });
  } finally {
    await fixture.cleanup();
  }
});

test('Linux installer validates the AppImage before creating the XDG root', async () => {
  const fixture = await createFixture('isagi-invalid-source-');
  try {
    const invalidAppImage = resolve(fixture.assetDirectory, 'invalid.AppImage');
    await writeExecutable(invalidAppImage, '#!/bin/sh\nexit 9\n');
    await assert.rejects(
      () => runInstaller(fixture, [invalidAppImage]),
      /AppImage extraction failed/u,
    );
    await assert.rejects(() => lstat(fixture.dataHome), { code: 'ENOENT' });
  } finally {
    await fixture.cleanup();
  }
});

test('Linux installer validates every embedded icon before creating the XDG root', async (t) => {
  for (const [name, options] of [
    ['missing icon', { missingIcon: 96 }],
    ['symlink icon', { symlinkIcon: 96 }],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture(`isagi-invalid-icon-${name.replace(' ', '-')}-`, options);
      try {
        await assert.rejects(() => runInstaller(fixture), /missing the 96x96 Isagi icon/u);
        await assert.rejects(() => lstat(fixture.dataHome), { code: 'ENOENT' });
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test('Desktop Entry decoder round-trips specification-derived golden quoted Exec values', () => {
  const golden = [
    ['Exec="/tmp/a b"', '/tmp/a b'],
    [String.raw`Exec="/tmp/a\\\\b"`, String.raw`/tmp/a\b`],
    [String.raw`Exec="/tmp/a\\"b"`, '/tmp/a"b'],
    [String.raw`Exec="/tmp/a\\$b"`, '/tmp/a$b'],
    ['Exec="/tmp/a\\\\`b"', '/tmp/a`b'],
    ['Exec="/tmp/a%%b"', '/tmp/a%b'],
    [String.raw`Exec="/tmp/雪 a\\\\b\\"c\\$d\\` + '`' + String.raw`e%%f"`, '/tmp/雪 a\\b"c$d`e%f'],
  ];
  for (const [encoded, expected] of golden) assert.equal(decodeDesktopExec(encoded), expected);
});

test('Desktop Entry decoder rejects malformed general escapes, quoting, and field codes', () => {
  for (const invalid of [
    String.raw`Exec="/tmp/\q"`,
    'Exec=/tmp/unquoted',
    'Exec="/tmp/unterminated',
    'Exec="/tmp/a" trailing',
    'Exec="/tmp/%f"',
    'Exec="/tmp/%Q"',
    'Exec="/tmp/%"',
  ]) {
    assert.throws(() => decodeDesktopExec(invalid));
  }
});

test('Linux installer reports desktop database failure after committing the installation', async () => {
  const fixture = await createFixture('isagi-database-failure-', { databaseExit: 7 });
  try {
    await assert.rejects(() => runInstaller(fixture), /update-desktop-database failed/u);
    assert.equal(
      (
        await readFile(
          resolve(fixture.dataHome, 'applications/studio.yourtechbud.isagi.desktop'),
          'utf8',
        )
      ).includes('X-Isagi-Managed=true'),
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('Linux installer rejects unsafe managed file types and ownership', async (t) => {
  await t.test('symlink AppImage destination', async () => {
    const fixture = await createFixture('isagi-target-symlink-');
    try {
      const appDirectory = resolve(fixture.dataHome, 'isagi');
      await mkdir(appDirectory, { recursive: true });
      await symlink(fixture.appImage, resolve(appDirectory, 'Isagi.AppImage'));
      await assert.rejects(() => runInstaller(fixture), /managed file is a symlink/u);
    } finally {
      await fixture.cleanup();
    }
  });
  await t.test('foreign-owned AppImage destination', async () => {
    const fixture = await createFixture('isagi-target-owner-');
    try {
      const appDestination = resolve(fixture.dataHome, 'isagi/Isagi.AppImage');
      await mkdir(dirname(appDestination), { recursive: true });
      await writeFile(appDestination, 'old');
      const statWrapper = resolve(fixture.binDirectory, 'stat');
      await writeExecutable(
        statWrapper,
        `#!/bin/sh\ncase "${'$'}*" in *Isagi.AppImage*) printf '424242\\n' ;; *) /usr/bin/stat "${'$'}@" ;; esac\n`,
      );
      await assert.rejects(() => runInstaller(fixture), /not owned by the invoking user/u);
    } finally {
      await fixture.cleanup();
    }
  });
});

async function createFixture(prefix, options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  const dataHome = resolve(root, 'data home \\ 雪 $`%"');
  const assetDirectory = resolve(root, 'release assets');
  const binDirectory = resolve(root, 'bin');
  const appImage = resolve(assetDirectory, 'explicit image.AppImage');
  const databaseLog = resolve(root, 'desktop-database.log');
  await mkdir(assetDirectory);
  await mkdir(binDirectory);
  await writeExecutable(resolve(binDirectory, 'uname'), fakeUname());
  await writeExecutable(resolve(binDirectory, 'od'), fakeOd());
  await writeExecutable(
    resolve(binDirectory, 'update-desktop-database'),
    `#!/bin/sh\nprintf '%s\\n' "$1" >>${shellQuote(databaseLog)}\nexit ${options.databaseExit ?? 0}\n`,
  );
  await writeExecutable(appImage, fakeAppImage(iconSource, options));
  const environment = {
    ...process.env,
    HOME: resolve(root, 'home'),
    PATH: `${binDirectory}:${process.env.PATH}`,
    XDG_DATA_HOME: dataHome,
  };
  return {
    appImage,
    assetDirectory,
    binDirectory,
    cleanup: () => rm(root, { recursive: true, force: true }),
    dataHome,
    databaseInvocations: () => {
      try {
        return readFileSyncLines(databaseLog);
      } catch {
        return 0;
      }
    },
    environment,
    root,
  };
}

function runInstaller(fixture, args = [fixture.appImage], environment = {}) {
  return run('sh', [installer, ...args], { ...fixture.environment, ...environment });
}

function run(command, args, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise({ stdout });
      else reject(new Error(stderr.trim() || `installer exited ${code}`));
    });
  });
}

function fakeUname() {
  return '#!/bin/sh\ncase "$1" in -s) printf "Linux\\n" ;; -m) printf "x86_64\\n" ;; *) printf "Linux\\n" ;; esac\n';
}

function fakeOd() {
  return '#!/bin/sh\ncase " $* " in *" -N 4 "*) printf " 7f 45 4c 46\\n" ;; *) printf " 3e 00\\n" ;; esac\n';
}

function fakeAppImage(sourceIcon, options = {}) {
  const commands = [
    '#!/bin/sh',
    '[ "${1-}" = "--appimage-extract" ] || exit 2',
    'root=$PWD/squashfs-root',
    'mkdir -p "$root"',
    `printf '%s\\n' '[Desktop Entry]' 'Name=Isagi' 'Icon=isagi' >"$root/studio.yourtechbud.isagi.desktop"`,
  ];
  for (const size of sizes) {
    if (options.missingIcon === size) continue;
    commands.push(`mkdir -p "$root/usr/share/icons/hicolor/${size}x${size}/apps"`);
    if (options.symlinkIcon === size) {
      commands.push(
        `ln -s ${shellQuote(sourceIcon)} "$root/usr/share/icons/hicolor/${size}x${size}/apps/isagi.png"`,
      );
    } else {
      commands.push(
        `cp ${shellQuote(sourceIcon)} "$root/usr/share/icons/hicolor/${size}x${size}/apps/isagi.png"`,
      );
    }
  }
  return `${commands.join('\n')}\n`;
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readFileSyncLines(path) {
  const contents = requireReadFile(path);
  return contents.trim() === '' ? 0 : contents.trim().split('\n').length;
}

function requireReadFile(path) {
  return readFileSync(path, 'utf8');
}

function decodeDesktopExec(line) {
  assert.equal(typeof line, 'string');
  assert.equal(line.startsWith('Exec='), true);
  const generallyDecoded = decodeDesktopString(line.slice('Exec='.length));
  if (!generallyDecoded.startsWith('"')) throw new Error('Exec argument is not quoted.');
  let value = '';
  let index = 1;
  let closed = false;
  while (index < generallyDecoded.length) {
    const character = generallyDecoded[index];
    if (character === '"') {
      closed = true;
      index += 1;
      break;
    }
    if (character === '\\') {
      const escaped = generallyDecoded[index + 1];
      if (!['"', '`', '$', '\\'].includes(escaped)) throw new Error('Invalid Exec escape.');
      value += escaped;
      index += 2;
      continue;
    }
    if (character === '%') {
      if (generallyDecoded[index + 1] !== '%') throw new Error('Invalid field code.');
      value += '%';
      index += 2;
      continue;
    }
    value += character;
    index += 1;
  }
  if (!closed || index !== generallyDecoded.length) throw new Error('Malformed quoted Exec value.');
  return value;
}

function decodeDesktopString(value) {
  const escapes = { s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' };
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') {
      decoded += value[index];
      continue;
    }
    const escaped = value[index + 1];
    if (!(escaped in escapes)) throw new Error('Invalid general string escape.');
    decoded += escapes[escaped];
    index += 1;
  }
  return decoded;
}
