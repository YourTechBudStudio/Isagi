type TokenMatch = {
  score: number;
  lastIndex: number;
};

const BASE_MATCH_SCORE = 10;
const CONSECUTIVE_BONUS = 15;
const WORD_START_BONUS = 8;
const PREFIX_BONUS = 12;
const GAP_PENALTY = 2;
const EXACT_MATCH_BONUS = 200;
const PREFIX_MATCH_BONUS = 50;

function isLowercase(char: string): boolean {
  return char >= "a" && char <= "z";
}

function isUppercase(char: string): boolean {
  return char >= "A" && char <= "Z";
}

function isWordBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;

  const previous = text[index - 1];
  const current = text[index];

  if (
    previous === " " ||
    previous === "_" ||
    previous === "-" ||
    previous === "/"
  ) {
    return true;
  }

  if (isLowercase(previous) && isUppercase(current)) {
    return true;
  }

  return false;
}

function matchToken(
  target: string,
  targetLower: string,
  tokenLower: string,
  startIndex: number,
): TokenMatch | null {
  let score = 0;
  let lastIndex = startIndex - 1;
  let searchIndex = startIndex;

  for (let i = 0; i < tokenLower.length; i += 1) {
    const char = tokenLower[i];
    const index = targetLower.indexOf(char, searchIndex);
    if (index === -1) return null;

    const gap = index - lastIndex - 1;
    if (gap > 0) {
      score -= gap * GAP_PENALTY;
    }

    score += BASE_MATCH_SCORE;

    if (index === 0) {
      score += PREFIX_BONUS;
    } else if (isWordBoundary(target, index)) {
      score += WORD_START_BONUS;
    }

    if (index === lastIndex + 1) {
      score += CONSECUTIVE_BONUS;
    }

    lastIndex = index;
    searchIndex = index + 1;
  }

  return { score, lastIndex };
}

export function fuzzyScore(query: string, target: string): number | null {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return null;

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const queryLower = normalizedQuery.toLowerCase();
  const targetLower = target.toLowerCase();

  let score = 0;
  let startIndex = 0;

  for (const token of tokens) {
    const tokenMatch = matchToken(
      target,
      targetLower,
      token.toLowerCase(),
      startIndex,
    );
    if (!tokenMatch) return null;
    score += tokenMatch.score;
    startIndex = tokenMatch.lastIndex + 1;
  }

  if (targetLower === queryLower) {
    score += EXACT_MATCH_BONUS;
  } else if (targetLower.startsWith(queryLower)) {
    score += PREFIX_MATCH_BONUS;
  }

  return score;
}
