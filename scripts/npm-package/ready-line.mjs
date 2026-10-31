const readyPrefix = 'ISAGI_RUNTIME_READY ';

/**
 * The URL from the runtime's `ISAGI_RUNTIME_READY {"url":"…"}` line in `stdout` so far, or `undefined` while no
 * complete ready line has arrived. Pipe chunks do not keep line boundaries, so a line counts only once its newline is
 * in. Throws when a complete ready line does not carry a URL.
 */
export function readyUrl(stdout) {
  const complete = stdout.slice(0, stdout.lastIndexOf('\n') + 1);
  const line = complete.split(/\r?\n/u).find((candidate) => candidate.startsWith(readyPrefix));
  if (line === undefined) return undefined;
  let record;
  try {
    record = JSON.parse(line.slice(readyPrefix.length));
  } catch {
    throw new Error(`malformed ready line: ${line}`);
  }
  if (typeof record?.url !== 'string') throw new Error(`ready line has no url: ${line}`);
  return record.url;
}
