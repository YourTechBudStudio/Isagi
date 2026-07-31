const canonicalVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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
