// Shared visual language for the app screens (colours, spacing, elevation) so the Notes,
// Owl and Settings screens read as one product rather than three ad-hoc layouts. Kept in
// the app layer (RN-facing) — the pure src/ui presenters stay style-free.

export const theme = {
  // Surfaces
  bg: '#f4f6fb', // app background (soft blue-grey, so white cards lift off it)
  surface: '#ffffff',
  surfaceMuted: '#eef1f7',

  // Brand
  primary: '#2f4bff', // Kano blue
  primaryDark: '#1f36d6',
  onPrimary: '#ffffff',

  // Text
  text: '#0f172a',
  muted: '#5b6472',
  faint: '#9aa3b2',

  // Lines + status
  border: '#e3e8f0',
  danger: '#dc2626',
  success: '#16a34a',

  radius: 14,
  radiusSm: 10,
} as const;

// A soft card elevation that works on both iOS (shadow*) and Android (elevation).
export const cardShadow = {
  shadowColor: '#1e293b',
  shadowOpacity: 0.08,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 3 },
  elevation: 2,
} as const;
