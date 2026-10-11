/**
 * Design tokens. A restyle should mostly mean editing this file and primitives.tsx.
 * Accessibility floor for older patients: >= 56 px touch targets, >= 20 px body text
 * on the patient app, WCAG AA contrast (4.5:1) or better.
 */
export const theme = {
  color: {
    background: '#FFFFFF',
    surface: '#F2F4F7',
    text: '#111827',
    textMuted: '#4B5563',
    primary: '#0B57D0',
    onPrimary: '#FFFFFF',
    secondary: '#E5E7EB',
    onSecondary: '#111827',
    success: '#0F7B3F',
    warning: '#9A5B00',
    danger: '#B42318',
    overlay: 'rgba(0,0,0,0.65)',
    box: '#22C55E',
    border: '#D1D5DB',
  },
  space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 6, md: 12, lg: 20 },
  font: { small: 14, body: 18, patientBody: 22, title: 26, hero: 34 },
  touch: { minHeight: 56 },
} as const;

export type Theme = typeof theme;
