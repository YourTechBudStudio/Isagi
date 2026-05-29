import process from 'node:process';

import { formatReadyLine, parsePort, startRuntimeServer } from './server.js';

const host = process.env.HOST;
const port = parsePort(process.env.PORT);
const { server, url } = await startRuntimeServer(host ? { host, port } : { port });

console.log(formatReadyLine(url));

const close = async () => {
  await server.close();
};

process.once('SIGINT', () => {
  void close().finally(() => process.exit(0));
});

process.once('SIGTERM', () => {
  void close().finally(() => process.exit(0));
});
