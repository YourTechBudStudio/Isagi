import { CliFailure } from './errors.js';

/**
 * The runtime this invocation calls: `--runtime-url`, else `ISAGI_RUNTIME_URL`, else none.
 *
 * Isagi puts `ISAGI_RUNTIME_URL` into every terminal and agent session it launches. The value must
 * be a plain `http:` or `https:` URL without credentials, which is also what makes it safe to echo
 * in an error document.
 */
export function resolveRuntimeUrl(input: {
  readonly flag: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}):
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly failure: CliFailure } {
  const fromEnvironment = input.env.ISAGI_RUNTIME_URL;
  const source =
    input.flag !== undefined
      ? { value: input.flag, name: '--runtime-url' }
      : fromEnvironment !== undefined && fromEnvironment !== ''
        ? { value: fromEnvironment, name: 'ISAGI_RUNTIME_URL' }
        : undefined;
  if (!source) {
    return {
      ok: false,
      failure: CliFailure.of(
        'runtime_unconfigured',
        'No runtime URL: run inside an Isagi terminal (which sets ISAGI_RUNTIME_URL) or pass --runtime-url.',
      ),
    };
  }

  let url: URL;
  try {
    url = new URL(source.value);
  } catch {
    return { ok: false, failure: invalid(source.name, 'is not a URL') };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, failure: invalid(source.name, 'must be an http: or https: URL') };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, failure: invalid(source.name, 'must not carry credentials') };
  }
  return { ok: true, url: url.toString() };
}

function invalid(name: string, problem: string) {
  return CliFailure.of('cli_usage_invalid', `${name} ${problem}.`, { source: name });
}
