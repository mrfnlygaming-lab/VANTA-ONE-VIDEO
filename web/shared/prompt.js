export const MAX_IMAGES = 6;
export const MAX_TOTAL_DURATION = 60;
export const MAX_PROMPT_LENGTH = 1000;

// Prompts choose a supported camera move. Other words remain a saved scene note.
export function promptMotion(prompt) {
  const text = String(prompt ?? "").toLowerCase();
  const patterns = [
    ["zoom-in", /\b(?:zoom\s+in|push\s+in|move\s+closer)\b/],
    ["zoom-out", /\b(?:zoom\s+out|pull\s+out|pull\s+back)\b/],
    ["pan-left", /\b(?:pan\s+left|move\s+left|camera\s+left)\b/],
    ["pan-right", /\b(?:pan\s+right|move\s+right|camera\s+right)\b/],
    ["still", /\b(?:still|static|no\s+movement|hold\s+the\s+frame)\b/],
  ];
  const matches = patterns
    .map(([motion, pattern]) => ({ motion, match: pattern.exec(text) }))
    .filter((item) => item.match)
    .sort((a, b) => a.match.index - b.match.index);
  return matches[0]?.motion ?? null;
}

export function resolvePromptMotion(prompt, fallback = "zoom-in") {
  return promptMotion(prompt) ?? fallback;
}
