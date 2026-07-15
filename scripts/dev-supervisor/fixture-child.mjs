import process from 'node:process';

const mode = process.argv[2];

if (mode === 'web-ready') {
  process.stdout.write('ISAGI_WEB_');
  setTimeout(
    () =>
      process.stdout.write(
        'READY {"protocolVersion":1,"mode":"dev","url":"http://127.0.0.1:43210/"}\n',
      ),
    5,
  );
  process.once('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 1_000);
} else if (mode === 'web-duplicate') {
  const record =
    'ISAGI_WEB_READY {"protocolVersion":1,"mode":"dev","url":"http://127.0.0.1:43210/"}\n';
  process.stdout.write(record);
  setTimeout(() => process.stdout.write(record), 10);
  setInterval(() => {}, 1_000);
} else if (mode === 'web-ready-exit') {
  process.stdout.write(
    'ISAGI_WEB_READY {"protocolVersion":1,"mode":"dev","url":"http://127.0.0.1:43210/"}\n',
  );
  setTimeout(() => process.exit(0), 20);
} else if (mode === 'web-malformed') {
  process.stdout.write('ISAGI_WEB_READY nope\n');
  setInterval(() => {}, 1_000);
} else if (mode === 'web-silent') {
  setInterval(() => {}, 1_000);
} else if (mode === 'web-failure') {
  process.exit(4);
} else if (mode === 'web-success') {
  process.exit(0);
} else if (mode === 'desktop-success') {
  process.stdout.write('desktop partial');
  setTimeout(() => process.exit(0), 20);
} else if (mode === 'desktop-runtime-failure') {
  const payload = Buffer.from('runtime failed\n').toString('base64');
  process.stdout.write(
    `ISAGI_DEV_LOG ${JSON.stringify({ protocolVersion: 1, source: 'runtime', stream: 'stderr', encoding: 'base64', payload })}\n`,
  );
  setTimeout(() => process.exit(7), 20);
} else if (mode === 'desktop-wait') {
  process.once('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 1_000);
} else if (mode === 'desktop-stage-gate') {
  process.stdout.write('desktop started\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (!chunk.includes('"runtimeStage":"ready"')) return;
    process.stdout.write('runtime stage released\n');
    process.exit(0);
  });
} else if (mode === 'preparation-success') {
  const delay = Number(process.argv[3] ?? 0);
  const label = process.argv[4] ?? 'preparation';
  setTimeout(() => {
    process.stdout.write(`${label} ready\n`);
    process.exit(0);
  }, delay);
} else if (mode === 'resist-term') {
  process.once('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
} else {
  process.exit(2);
}
