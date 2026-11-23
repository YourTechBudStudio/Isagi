import { readFileSync } from 'node:fs';

import { type Document, parseDocument, YAMLError } from 'yaml';

import { globalConfigPath } from './location.js';

/**
 * Why `config.yaml` could not be read or parsed, kept to fields that cannot carry config text: the
 * raw system error code, or a YAML error code and position. Never a parser message, which can quote
 * the file, and the file can hold inline keys. `systemErrorCode` is not allowlisted here: a caller
 * that renders it applies its own allowlist.
 */
export type GlobalConfigReadFailure =
  | { readonly reason: 'read_failed'; readonly systemErrorCode: string | null }
  | {
      readonly reason: 'yaml_syntax';
      readonly yamlCode: string;
      readonly line: number | null;
      readonly column: number | null;
    };

/** A parsed `config.yaml`: its bytes, its YAML document and the document as plain values. */
export interface GlobalConfigFile {
  readonly bytes: string;
  readonly document: Document;
  readonly value: unknown;
}

export type GlobalConfigParse =
  | ({ readonly status: 'loaded' } & GlobalConfigFile)
  | { readonly status: 'failed'; readonly failure: GlobalConfigReadFailure };

export type GlobalConfigRead = GlobalConfigParse | { readonly status: 'missing' };

/** Reads and parses `config.yaml` in `dataDirectory`. Synchronous, so a caller can use it before painting. */
export function readGlobalConfig(dataDirectory: string): GlobalConfigRead {
  return readGlobalConfigFile(globalConfigPath(dataDirectory));
}

/** Reads and parses the config file at `path`; a file that does not exist is `missing`. */
export function readGlobalConfigFile(path: string): GlobalConfigRead {
  let bytes: string;
  try {
    bytes = readFileSync(path, 'utf8');
  } catch (cause) {
    const code = systemErrorCode(cause);
    if (code === 'ENOENT') return { status: 'missing' };
    return { status: 'failed', failure: { reason: 'read_failed', systemErrorCode: code } };
  }
  return parseGlobalConfig(bytes);
}

/** Parses `bytes` as `config.yaml` and converts it to plain values. */
export function parseGlobalConfig(bytes: string): GlobalConfigParse {
  const document = parseDocument(bytes);
  const [error] = document.errors;
  if (error !== undefined) return { status: 'failed', failure: yamlFailure(error) };
  const value = globalConfigDocumentValue(document);
  return value.status === 'converted'
    ? { status: 'loaded', bytes, document, value: value.value }
    : value;
}

/**
 * `document` as plain values. Conversion can fail after a clean parse (an unresolved alias, too many
 * aliases), and its error quotes the source, so it gets the same safe failure as parsing.
 */
export function globalConfigDocumentValue(
  document: Document,
):
  | { readonly status: 'converted'; readonly value: unknown }
  | { readonly status: 'failed'; readonly failure: GlobalConfigReadFailure } {
  try {
    return { status: 'converted', value: document.toJS() as unknown };
  } catch (cause) {
    return {
      status: 'failed',
      failure:
        cause instanceof YAMLError
          ? yamlFailure(cause)
          : { reason: 'yaml_syntax', yamlCode: 'YAML_CONVERSION_FAILED', line: null, column: null },
    };
  }
}

function yamlFailure(error: YAMLError): GlobalConfigReadFailure {
  const position = error.linePos?.[0];
  return {
    reason: 'yaml_syntax',
    yamlCode: error.code,
    line: position?.line ?? null,
    column: position?.col ?? null,
  };
}

function systemErrorCode(cause: unknown): string | null {
  const code =
    typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : null;
  return typeof code === 'string' ? code : null;
}
