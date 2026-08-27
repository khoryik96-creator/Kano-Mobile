// Note importance / urgency levels (1–4), matching the extension's priority scale and
// its left-border colours (priority-1 green … priority-4 red). Pure data + a coercion
// helper so the editor picker and the list badge stay in sync.

export interface ImportanceLevel {
  value: number;
  label: string;
  color: string;
}

export const IMPORTANCE_LEVELS: ImportanceLevel[] = [
  { value: 1, label: 'Low', color: '#16a34a' },
  { value: 2, label: 'Normal', color: '#eab308' },
  { value: 3, label: 'High', color: '#f97316' },
  { value: 4, label: 'Urgent', color: '#dc2626' },
];

/** Coerce any value to a valid importance level (default Normal / 2). */
export function importanceLevel(value: number | undefined | null): ImportanceLevel {
  const v = Math.max(1, Math.min(4, Number(value || 2) || 2));
  return IMPORTANCE_LEVELS.find((l) => l.value === v) ?? IMPORTANCE_LEVELS[1]!;
}
