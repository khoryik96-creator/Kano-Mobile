// FNV-1a (32-bit), as base36. Shared by the stable note ids — which MUST match the
// extension byte-for-byte (pinned by fixtures/stable_id.json) — and the Owl's ids for
// messages saved by older builds.

export function fnv1a36(seed: string): string {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
  }
  return (hash >>> 0).toString(36);
}
