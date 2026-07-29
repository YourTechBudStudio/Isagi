import { build, preview } from 'vite';

const port = Number(process.argv[2]);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new RangeError('fixture server requires a valid port');
}

const configFile = new URL('./vite.fixture.config.ts', import.meta.url).pathname;
await build({ configFile });
const server = await preview({
  configFile,
  preview: { host: '127.0.0.1', port, strictPort: true },
});

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await new Promise((resolve, reject) => {
    server.httpServer.close((error) => (error ? reject(error) : resolve()));
  });
};

process.once('SIGTERM', () => void close().then(() => process.exit(0)));
process.once('SIGINT', () => void close().then(() => process.exit(130)));
