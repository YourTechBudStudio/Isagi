import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// One exact long-form spelling per concept. Short and alias spellings are
// deliberately absent so the accepted grammar matches what the errors and
// documentation claim, leaving no parser surface beyond the shipped commands.
const platformFlags = new Map([
  ['--linux', 'linux'],
  ['--mac', 'darwin'],
  ['--win', 'win32'],
]);

const architectureFlags = new Map([
  ['--x64', 'x64'],
  ['--arm64', 'arm64'],
  ['--ia32', 'ia32'],
  ['--armv7l', 'armv7l'],
  ['--universal', 'universal'],
]);

const publishFlag = '--publish';
// Recognized so a policy that uploads can be refused by name rather than as an
// opaque unrecognized token. Only `never` is ever accepted.
const publishValues = new Set(['never', 'always', 'onTag', 'onTagOrDraft']);
export const requiredPublishPolicy = 'never';
const targetNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

// The Linux distribution contract is exactly one x64 AppImage. electron-builder.yml
// pins that target and architecture, so an invocation with no explicit Linux
// selection builds it, and any other explicit Linux selection is unsupported.
export const linuxReleaseArchitecture = 'x64';
export const linuxReleaseTarget = 'AppImage';

/**
 * Parse the platform, architecture, and per-platform target selections
 * electron-builder will act on, so packaging decisions key off what the build
 * actually produces rather than off the exact argument tokens a caller typed.
 *
 * This deliberately recognizes one exact spelling per concept instead of
 * reimplementing electron-builder's yargs grammar. yargs also accepts
 * `--linux=AppImage`, `-l=AppImage`, `--x64=true`, short aliases such as `-l`
 * and `-p`, and combined short flags such as `-mwl`; any attempt to mirror that
 * grammar here would be a second
 * parser free to drift out of agreement with the real one, and disagreement is
 * precisely what lets an unverified Linux artifact escape. Every token that is
 * not recognized exactly is therefore returned in `unrecognized` and refused
 * before the build, rather than guessed at.
 */
export function parseBuilderArguments(args) {
  const targetsByPlatform = new Map();
  const architectures = [];
  const publishPolicies = [];
  const unrecognized = [];
  let dir = false;
  let currentPlatform;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === publishFlag) {
      currentPlatform = undefined;
      const value = args[index + 1];
      if (value !== undefined && publishValues.has(value)) publishPolicies.push(value);
      else unrecognized.push(arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      currentPlatform = undefined;
      if (arg === '--dir') {
        dir = true;
      } else if (architectureFlags.has(arg)) {
        architectures.push(architectureFlags.get(arg));
      } else if (platformFlags.has(arg)) {
        currentPlatform = platformFlags.get(arg);
        if (!targetsByPlatform.has(currentPlatform)) targetsByPlatform.set(currentPlatform, []);
      } else {
        unrecognized.push(arg);
      }
      continue;
    }
    // Bare values only mean targets while a platform flag is still in scope;
    // any other flag (`--publish never`) ends that scope above.
    if (currentPlatform && targetNamePattern.test(arg)) {
      targetsByPlatform.get(currentPlatform).push(arg);
      continue;
    }
    unrecognized.push(arg);
  }
  return { architectures, dir, publishPolicies, targetsByPlatform, unrecognized };
}

/**
 * Classify a packaging invocation into exactly one of three outcomes:
 *
 * - `linux-release`: produces the canonical linux/x64 AppImage, whether reached
 *   through `dist` on a Linux host or the explicit `dist:linux` entry point.
 *   The wrapper stages the installer and runs the complete Linux verifier.
 * - `unsupported`: requests a Linux distribution Isagi does not ship. This must
 *   fail before the build runs rather than quietly skip verification, because
 *   electron-builder would still emit the stable-named AppImage beside it.
 * - `other`: a non-Linux distribution or an unpacked `--dir` build, neither of
 *   which is a Linux distribution operation.
 *
 * The host architecture is deliberately not an input: the configuration pins the
 * Linux artifact to x64, so only an explicit flag can change it.
 */
export function classifyPackagingRequest(args, platform = process.platform) {
  const request = parseBuilderArguments(args);
  // Refuse unrecognized spellings before anything else, and without regard to
  // the host platform. An alternative spelling can select Linux while looking
  // like something else here: `-mwl` on macOS builds all three platforms, and
  // `--linux=deb` reads as no explicit selection at all. Classifying either one
  // would let electron-builder emit an unverified Linux artifact.
  if (request.unrecognized.length > 0) {
    return unsupported(
      `unrecognized packaging arguments: ${request.unrecognized.join(', ')}. Isagi accepts only exact long-form flags, so alternative electron-builder spellings such as --linux=AppImage, -l=AppImage, --x64=true, and combined flags such as -mwl are refused rather than interpreted`,
    );
  }
  // Isagi verifies artifacts only after electron-builder has produced them, and
  // electron-builder schedules uploads as each artifact is created. A publishing
  // build therefore uploads before parity, smoke, installer staging, ELF
  // inspection, and release verification have run, and no later failure can
  // retract an upload. Omitting the policy is not safe either: electron-builder
  // publishes implicitly under an npm `release` lifecycle event, on a git tag,
  // or on CI detection. Every invocation must say `never`, exactly once.
  if (
    request.publishPolicies.length !== 1 ||
    request.publishPolicies[0] !== requiredPublishPolicy
  ) {
    return unsupported(publishPolicyReason(request.publishPolicies));
  }
  // `--dir` is unpacked packaging; electron-builder ignores target selections
  // for it, so it is never a distribution decision.
  if (request.dir) return { kind: 'other' };
  const platforms =
    request.targetsByPlatform.size === 0 ? [platform] : [...request.targetsByPlatform.keys()];
  if (!platforms.includes('linux')) return { kind: 'other' };
  if (platforms.length > 1) {
    return unsupported(
      `packaging Linux together with ${platforms.filter((entry) => entry !== 'linux').join(', ')} would emit an unverified Linux distribution`,
    );
  }
  if (request.architectures.length > 1) {
    return unsupported(`conflicting architecture selections: ${request.architectures.join(', ')}`);
  }
  const selectedArchitecture = request.architectures[0] ?? linuxReleaseArchitecture;
  if (selectedArchitecture !== linuxReleaseArchitecture) {
    return unsupported(
      `Linux ${selectedArchitecture} is not a supported distribution architecture`,
    );
  }
  const targets = request.targetsByPlatform.get('linux') ?? [];
  if (targets.length === 0) return { kind: 'linux-release' };
  if (targets.length === 1 && targets[0] === linuxReleaseTarget) return { kind: 'linux-release' };
  return unsupported(`Linux target selection ${targets.join(', ')} is not ${linuxReleaseTarget}`);
}

export function unsupportedPackagingMessage(reason) {
  return `Unsupported packaging request: ${reason}. Isagi ships exactly one Linux artifact, an ${linuxReleaseArchitecture} ${linuxReleaseTarget}; the supported commands are pnpm package:desktop, pnpm package:desktop:linux, and pnpm pack:desktop.`;
}

export function resolveApplicationRoot(
  args,
  releaseRoot,
  platform = process.platform,
  architecture = process.arch,
) {
  const request = parseBuilderArguments(args);
  const platforms =
    request.targetsByPlatform.size === 0 ? [platform] : [...request.targetsByPlatform.keys()];
  const selected = platforms.length === 1 ? platforms[0] : undefined;
  // Only macOS takes its architecture from the host; the Linux configuration
  // pins x64 regardless of the machine that runs the build.
  const root =
    selected === 'darwin'
      ? join(
          releaseRoot,
          (request.architectures[0] ?? architecture) === 'arm64' ? 'mac-arm64' : 'mac',
          'Isagi.app',
        )
      : selected === 'linux'
        ? join(
            releaseRoot,
            (request.architectures[0] ?? linuxReleaseArchitecture) === 'arm64'
              ? 'linux-arm64-unpacked'
              : 'linux-unpacked',
          )
        : '';
  if (!root || !existsSync(root)) {
    throw new Error(`Current packaged application output is missing at ${root || releaseRoot}`);
  }
  return root;
}

function unsupported(reason) {
  return { kind: 'unsupported', reason };
}

function publishPolicyReason(policies) {
  if (policies.length === 0) {
    return `missing ${publishFlag} ${requiredPublishPolicy}; electron-builder publishes implicitly on a git tag, on CI, or under an npm release lifecycle event, which would upload artifacts before Isagi verifies them`;
  }
  if (policies.length > 1) {
    return `${publishFlag} was given ${policies.length} times (${policies.join(', ')}); exactly one ${requiredPublishPolicy} is required`;
  }
  return `${publishFlag} ${policies[0]} would upload artifacts before Isagi verifies them; only ${requiredPublishPolicy} is accepted`;
}
