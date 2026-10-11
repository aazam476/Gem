/**
 * Design tokens (Apple-style: system font, grouped backgrounds, hairline separators,
 * size-specific tracking). A restyle should mostly mean editing this file and
 * primitives.tsx. Accessibility floor for older patients: >= 56 pt touch targets,
 * >= 21 pt body text in the patient app, WCAG AA contrast or better.
 */
export const theme = {
  color: {
    background: '#F2F2F7', // grouped background (portal)
    surface: '#FFFFFF',
    surfaceMuted: '#F7F7FA',
    text: '#111114',
    textMuted: '#5B5B66', // 6.4:1 on white
    primary: '#0058D6', // white text on it: 5.8:1
    onPrimary: '#FFFFFF',
    secondary: '#E8E8EE',
    onSecondary: '#111114',
    success: '#0E7A3B',
    successSoft: '#E3F5EA',
    warning: '#8A5300',
    warningSoft: '#FFF2DC',
    danger: '#C0271A',
    dangerSoft: '#FDE7E5',
    separator: 'rgba(60, 60, 67, 0.16)',
    border: 'rgba(60, 60, 67, 0.22)',
    // Camera chrome (patient app): light text on dark translucent material.
    onCamera: '#FFFFFF',
    onCameraMuted: 'rgba(255, 255, 255, 0.82)',
    glassFallback: 'rgba(20, 20, 24, 0.72)',
    glassBorder: 'rgba(255, 255, 255, 0.14)',
    scrim: 'rgba(0, 0, 0, 0.55)',
    listening: '#34C759',
    hearing: '#FFD60A', // same yellow as the drawn boxes
    overlay: 'rgba(0, 0, 0, 0.6)',
    box: '#FFD60A',
  },
  space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
  radius: { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 },
  // [fontSize, lineHeight, letterSpacing]: tight tracking/leading as type grows.
  type: {
    small: [15, 20, 0],
    body: [17, 24, 0],
    patient: [21, 29, 0],
    title: [26, 31, -0.4],
    hero: [34, 40, -0.7],
  },
  font: { small: 15, body: 17, patientBody: 21, title: 26, hero: 34 },
  touch: { minHeight: 56 },
  content: { maxWidth: 980 },
} as const;

export type Theme = typeof theme;
