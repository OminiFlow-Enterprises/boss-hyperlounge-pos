function letters(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function words(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function oneEdit(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  if (i < a.length || j < b.length) edits++;
  return edits <= 1;
}

/** True when the typed text is one letter off a piece of the name, such as utra in ultra or urte. */
function oneEditSomewhere(text: string, query: string) {
  if (query.length < 2) return false;
  for (let len = query.length - 1; len <= query.length + 1; len++) {
    if (len < 1) continue;
    for (let i = 0; i + len <= text.length; i++) {
      if (oneEdit(text.slice(i, i + len), query)) return true;
    }
  }
  return false;
}

/** Lower score is a closer match. Null means the item does not match. */
export function itemMatchScore(name: string, sku: string, query: string) {
  const q = letters(query);
  if (!q) return null;
  let best: number | null = null;
  for (const raw of [name, sku]) {
    if (!raw) continue;
    const text = words(raw);
    const flat = letters(raw);
    if (!text) continue;
    let score: number | null = null;
    if (text.startsWith(q) || flat.startsWith(q)) score = 0;
    else if (text.split(" ").some((word) => word.startsWith(q))) score = 1;
    else if (text.includes(q) || flat.includes(q)) score = 2;
    else if (q.length >= 2 && oneEditSomewhere(flat, q)) score = 4;
    if (score != null) best = best == null ? score : Math.min(best, score);
  }
  return best;
}
