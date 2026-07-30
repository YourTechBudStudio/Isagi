import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const maximumFileBytes = 256 * 1024;
const maximumSummaryBytes = 4 * 1024;

export interface UpdaterDiagnosticRecord {
  readonly operation: 'composition' | 'check' | 'download' | 'lifecycle';
  readonly platform: string;
  readonly installedVersion: string;
  readonly targetVersion?: string | undefined;
  readonly code: string;
  readonly summary: string;
}

export interface UpdaterDiagnosticSink {
  write(record: UpdaterDiagnosticRecord): Promise<void>;
  flush(): Promise<void>;
}

export function createUpdaterDiagnosticSink(
  logDirectory: string,
  warn: (message: string) => void = console.warn,
): UpdaterDiagnosticSink {
  const currentPath = join(logDirectory, 'updater.jsonl');
  const previousPath = join(logDirectory, 'updater.previous.jsonl');
  let writes = Promise.resolve();
  let warningWritten = false;

  const enqueue = (record: UpdaterDiagnosticRecord) => {
    writes = writes.then(async () => {
      try {
        await mkdir(logDirectory, { recursive: true });
        const line = `${JSON.stringify(sanitizeRecord(record))}\n`;
        const lineBytes = Buffer.byteLength(line, 'utf8');
        const currentBytes = await stat(currentPath)
          .then((value) => value.size)
          .catch(() => 0);
        if (currentBytes > 0 && currentBytes + lineBytes > maximumFileBytes) {
          await rm(previousPath, { force: true });
          await rename(currentPath, previousPath);
        }
        await appendFile(currentPath, line, 'utf8');
      } catch {
        if (!warningWritten) {
          warningWritten = true;
          warn('[desktop] Updater diagnostics could not be persisted.');
        }
      }
    });
    return writes;
  };

  return {
    write: enqueue,
    flush: () => writes,
  };
}

function sanitizeRecord(record: UpdaterDiagnosticRecord) {
  return {
    recordedAt: new Date().toISOString(),
    operation: record.operation,
    platform: sanitizeText(record.platform),
    installedVersion: sanitizeText(record.installedVersion),
    ...(record.targetVersion ? { targetVersion: sanitizeText(record.targetVersion) } : {}),
    code: sanitizeText(record.code),
    summary: truncateUtf8(sanitizeText(record.summary), maximumSummaryBytes),
  };
}

const redacted = '[redacted]';
const urlPattern = /https?:\/\/[^\s"'<>\\)\]}]+/giu;
const credentialPattern =
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abposr]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+)/gu;
const presentedTokenPattern = /\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]+/giu;

/** Header values may contain spaces and semicolons, so they are consumed to the end of the line. */
const headerPattern =
  /(["']?)\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-amz-security-token)\b\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n,}]+)/giu;
/** Generic secret labels, whose value is a single quoted string or unquoted token. */
const labeledSecretPattern =
  /(["']?)\b(access_?token|api_?key|auth|client_secret|jwt|passwd|password|refresh_?token|secret|sig|signature|token)\b\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}"']+)/giu;

/**
 * Updater failures routinely quote signed release URLs and provider tokens. Every query value
 * in an HTTP(S) URL is dropped wholesale rather than guessing which parameter names carry
 * secrets; standalone credential formats and labeled secrets are redacted separately. Labels
 * are matched in JSON, quoted-configuration, and bare command forms alike.
 */
export function sanitizeText(value: string): string {
  return value
    .replace(urlPattern, redactUrl)
    .replace(credentialPattern, redacted)
    .replace(headerPattern, redactLabeledValue)
    .replace(labeledSecretPattern, redactLabeledValue)
    .replace(presentedTokenPattern, redacted);
}

/** Keeps the surrounding structure (quoting and separator) so the record stays diagnosable. */
function redactLabeledValue(
  _match: string,
  keyQuote: string,
  key: string,
  separator: string,
  value: string,
): string {
  const valueQuote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
  return `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${redacted}${valueQuote}`;
}

function redactUrl(url: string): string {
  const withoutUserInfo = url.replace(/^(https?:\/\/)[^/@\s]+@/iu, `$1${redacted}@`);
  const queryStart = withoutUserInfo.search(/[?#]/u);
  if (queryStart < 0) return withoutUserInfo;
  const origin = withoutUserInfo.slice(0, queryStart);
  const query = withoutUserInfo
    .slice(queryStart)
    .replace(/([?#&][^=&#\s]+)=[^&#\s]*/gu, `$1=${redacted}`);
  return `${origin}${query}`;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maximumBytes) return value;
  return bytes
    .subarray(0, maximumBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
}
