import { stripVTControlCharacters } from 'node:util';

import {
  developmentProtocolVersion,
  runtimeLogPrefix,
  webReadinessPrefix,
} from './dev-protocol.mjs';

export function parseWebReadiness(line) {
  if (!line.startsWith(webReadinessPrefix)) {
    if (line.startsWith(webReadinessPrefix.trimEnd())) {
      throw new Error('Web readiness used malformed framing.');
    }
    return undefined;
  }
  let record;
  try {
    record = JSON.parse(line.slice(webReadinessPrefix.length));
  } catch {
    throw new Error('Web readiness contained malformed JSON.');
  }
  if (
    record?.protocolVersion !== developmentProtocolVersion ||
    record.mode !== 'dev' ||
    typeof record.url !== 'string'
  ) {
    throw new Error('Web readiness did not match protocol version 1.');
  }
  return record;
}

export function parseRuntimeLog(line) {
  if (!line.startsWith(runtimeLogPrefix)) {
    if (line.startsWith(runtimeLogPrefix.trimEnd())) {
      throw new Error('Runtime log record used malformed framing.');
    }
    return undefined;
  }
  let record;
  try {
    record = JSON.parse(line.slice(runtimeLogPrefix.length));
  } catch {
    throw new Error('Runtime log framing contained malformed JSON.');
  }
  if (
    record?.protocolVersion !== developmentProtocolVersion ||
    record.source !== 'runtime' ||
    !['stdout', 'stderr'].includes(record.stream) ||
    record.encoding !== 'base64' ||
    typeof record.payload !== 'string'
  ) {
    throw new Error('Runtime log framing did not match protocol version 1.');
  }
  return { stream: record.stream, payload: Buffer.from(record.payload, 'base64').toString('utf8') };
}

export function createRecordDecoder(emit) {
  let buffered = '';
  return {
    write(chunk) {
      buffered += chunk;
      let boundary = findBoundary(buffered);
      while (boundary) {
        emit(buffered.slice(0, boundary.end), boundary.ending);
        buffered = buffered.slice(boundary.end);
        boundary = findBoundary(buffered);
      }
    },
    end() {
      if (buffered) emit(buffered, '');
      buffered = '';
    },
  };
}

function findBoundary(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\n') return { end: index + 1, ending: '\n' };
    if (value[index] === '\r') {
      if (index === value.length - 1) return undefined;
      const ending = value[index + 1] === '\n' ? '\r\n' : '\r';
      return { end: index + ending.length, ending };
    }
  }
  return undefined;
}

export function createLogPresenter({ stdout, stderr, color }) {
  const colors = {
    web: '\u001b[35m',
    desktop: '\u001b[34m',
    runtime: '\u001b[36m',
    dev: '\u001b[2m',
  };
  return ({ source, stream, payload }) => {
    const destination = stream === 'stderr' ? stderr : stdout;
    const visiblePayload = color ? payload : stripVTControlCharacters(payload);
    const prefix = color ? `${colors[source]}[${source}]\u001b[0m ` : `[${source}] `;
    destination.write(`${prefix}${visiblePayload}`);
  };
}
