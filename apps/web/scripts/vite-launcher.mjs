import process from 'node:process';

import { createServer, preview } from 'vite';

import { formatWebReadiness } from '../../../scripts/dev-supervisor/dev-protocol.mjs';

const launchKind = process.argv[2] ?? 'dev';

if (!['dev', 'preview'].includes(launchKind)) {
  console.error(`Unknown web launcher mode: ${launchKind}`);
  process.exit(2);
}

let options;
try {
  options = parseArguments(process.argv.slice(3));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const inlineConfig = {
  mode: options.mode,
  ...(launchKind === 'dev'
    ? {
        server: {
          host: options.host,
          port: options.port,
          strictPort: false,
        },
      }
    : {
        preview: {
          host: options.host,
          port: options.port,
          strictPort: false,
        },
      }),
};

const server =
  launchKind === 'dev' ? await createServer(inlineConfig) : await preview(inlineConfig);
if (launchKind === 'dev') await server.listen();

const url = selectCanonicalUrl(server.resolvedUrls);
process.stdout.write(`${formatWebReadiness({ mode: launchKind, url })}\n`);
server.printUrls();

let closing = false;
const close = async (exitCode) => {
  if (closing) return;
  closing = true;
  process.exitCode = exitCode;
  await server.close();
};

process.once('SIGINT', () => void close(130));
process.once('SIGTERM', () => void close(143));

function parseArguments(arguments_) {
  const parsed = { host: '127.0.0.1', port: 5173, mode: undefined };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--') continue;
    if (argument === '--host' || argument?.startsWith('--host=')) {
      parsed.host = optionValue(argument, arguments_, index);
      if (argument === '--host') index += 1;
      continue;
    }
    if (argument === '--port' || argument?.startsWith('--port=')) {
      const value = optionValue(argument, arguments_, index);
      if (argument === '--port') index += 1;
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error(`Invalid Vite port: ${value}`);
      }
      parsed.port = port;
      continue;
    }
    if (argument === '--mode' || argument?.startsWith('--mode=')) {
      parsed.mode = optionValue(argument, arguments_, index);
      if (argument === '--mode') index += 1;
      continue;
    }
    throw new Error(`Unsupported web launcher option: ${argument}`);
  }
  return parsed;
}

function optionValue(argument, arguments_, index) {
  const inlineValue = argument.slice(argument.indexOf('=') + 1);
  const value = argument.includes('=') ? inlineValue : arguments_[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
  return value;
}

function selectCanonicalUrl(resolvedUrls) {
  const candidates = [...(resolvedUrls?.local ?? []), ...(resolvedUrls?.network ?? [])];
  const selected = candidates[0];
  if (!selected) throw new Error('Vite started without publishing a resolved URL.');
  return new URL(selected).toString();
}

export { parseArguments, selectCanonicalUrl };
