// JSON extraction from model text — faithful lift of background.js:
// extractJsonCandidate / parseJsonFromText. Models often wrap JSON in ```json fences
// or prose; this strips the fences and slices the outermost {...} before parsing.

/** Strip code fences and return the outermost `{...}` slice (or the cleaned text). */
export function extractJsonCandidate(raw: unknown): string {
  const clean = String(raw ?? '{}')
    .replace(/```json|```/g, '')
    .trim();
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  return first >= 0 && last > first ? clean.slice(first, last + 1) : clean;
}

/** Parse a JSON object out of model text. Throws if the candidate is not valid JSON. */
export function parseJsonFromText(raw: unknown): unknown {
  return JSON.parse(extractJsonCandidate(raw));
}
