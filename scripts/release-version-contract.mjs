const canonicalVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseCanonicalVersion(value) {
  if (typeof value !== 'string') {
    return { _tag: 'invalid_version', reason: 'Version must be a string.' };
  }

  const match = value.match(canonicalVersionPattern);
  if (!match) {
    return {
      _tag: 'invalid_version',
      reason: 'Expected canonical MAJOR.MINOR.PATCH with no leading zeroes.',
    };
  }

  return {
    _tag: 'canonical_version',
    major: match[1],
    minor: match[2],
    patch: match[3],
    version: value,
  };
}

export function classifyReleaseTag(tagName) {
  if (typeof tagName !== 'string' || !tagName.startsWith('v')) {
    return { _tag: 'unrelated', tagName };
  }

  const version = tagName.slice(1);
  const match = version.match(semverPattern);
  if (!match || hasInvalidNumericPrereleaseIdentifier(match[4])) {
    return { _tag: 'invalid_tag', tagName };
  }

  if (match[4] !== undefined || match[5] !== undefined) {
    return { _tag: 'prerelease_ignored', tagName, version };
  }

  return { _tag: 'stable_release', tagName, version };
}

function hasInvalidNumericPrereleaseIdentifier(prerelease) {
  return prerelease
    ?.split('.')
    .some(
      (identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === '0',
    );
}
