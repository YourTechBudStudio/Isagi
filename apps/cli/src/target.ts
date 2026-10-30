import { CliFailure } from './errors.js';
import type { SourcedValue } from './serve/launch.js';
import { fromFlagOrEnv } from './settings.js';

/**
 * The runtime this invocation calls: `--runtime-url`, else `ISAGI_RUNTIME_URL`, else none.
 *
 * Isagi puts `ISAGI_RUNTIME_URL` into every terminal and agent session it launches. The value must
 * be a plain `http:` or `https:` URL without credentials, which is also what makes it safe to echo
 * in an error document. An invalid value is never echoed: it may carry credentials.
 */
export function resolveRuntimeUrl(input: {
  readonly flag: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}):
  | { readonly ok: true; readonly url: SourcedValue<string> }
  | { readonly ok: false; readonly failure: CliFailure } {
  const source = fromFlagOrEnv({
    flag: input.flag,
    flagName: '--runtime-url',
    envName: 'ISAGI_RUNTIME_URL',
    env: input.env,
  });
  if (!source) {
    return {
      ok: false,
      failure: CliFailure.of(
        'runtime_unconfigured',
        'No runtime URL: run inside an Isagi terminal (which sets ISAGI_RUNTIME_URL) or pass --runtime-url.',
        { context: { checked: ['--runtime-url', 'ISAGI_RUNTIME_URL'] } },
      ),
    };
  }

  let url: URL;
  try {
    url = new URL(source.value);
  } catch {
    return { ok: false, failure: invalid(source, 'is not a URL') };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, failure: invalid(source, 'must be an http: or https: URL') };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, failure: invalid(source, 'must not carry credentials') };
  }
  return { ok: true, url: { ...source, value: url.toString() } };
}

function invalid(source: SourcedValue<string>, problem: string) {
  return CliFailure.of('cli_usage_invalid', `${source.name} ${problem}.`, {
    context: { setting: 'runtimeUrl', source: source.source, name: source.name },
    recovery:
      source.source === 'env'
        ? `Set ${source.name} to a plain http: or https: URL without credentials, or pass --runtime-url.`
        : `Pass ${source.name} a plain http: or https: URL without credentials.`,
  });
}
