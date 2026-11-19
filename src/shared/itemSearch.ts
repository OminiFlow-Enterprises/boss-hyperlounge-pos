function tokens(value: string) {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Query words must occur in order as the start of name words.
 * 0 = from the first word with no gaps (full name or its opening words).
 * 1 = a later word, or consecutive words such as the 2nd and 3rd.
 * 2 = same order with a word skipped in between.
 * Null = no match.
 */
function sequenceScore(nameWords: string[], queryWords: string[]) {
  if (!queryWords.length || !nameWords.length) return null;
  let from = 0;
  let first = -1;
  let adjacent = true;
  for (const q of queryWords) {
    let at = -1;
    for (let i = from; i < nameWords.length; i++) {
      if (nameWords[i].startsWith(q)) {
        at = i;
        break;
      }
    }
    if (at < 0) return null;
    if (first < 0) first = at;
    else if (at !== from) adjacent = false;
    from = at + 1;
  }
  if (first === 0 && adjacent) return 0;
  if (adjacent) return 1;
  return 2;
}

/** Lower score is a closer match. Null means the item does not match. */
export function itemMatchScore(name: string, sku: string, query: string) {
  const queryWords = tokens(query);
  if (!queryWords.length) return null;
  let best: number | null = null;
  for (const raw of [name, sku]) {
    if (!raw) continue;
    const score = sequenceScore(tokens(raw), queryWords);
    if (score == null) continue;
    best = best == null ? score : Math.min(best, score);
  }
  return best;
}
