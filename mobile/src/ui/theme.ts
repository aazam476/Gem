/**
 * Design tokens (Apple-style: system font, grouped backgrounds, hairline separators,
 * size-specific tracking). Colors come in a light and a dark palette that follow the
 * system appearance; components read them with `useTheme()`. A restyle should mostly
 * mean editing this file and primitives.tsx. Accessibility floor for older patients: >= 56 pt touch targets,
 * >= 21 pt body text in the patient app, WCAG AA contrast or better.
 */
import { useColorScheme } from 'react-native';

export interface Palette {
  background: string; // grouped background (portal, permission screen)
  surface: string; // cards, sheets
  surfaceMuted: string; // nested groups inside a card
  text: string;
  textMuted: string;
  primary: string; // filled button background
  primaryText: string; // links, icons and plain buttons on surface/background
  onPrimary: string;
  secondary: string;
  onSecondary: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  separator: string;
  border: string;
  // Camera chrome (patient app): light text on dark translucent material, both modes.
  onCamera: string;
  onCameraMuted: string;
  glassFallback: string;
  glassTint: string;
  glassBorder: string;
  scrim: string;
  listening: string;
  hearing: string;
  photoBackdrop: string;
}

/** Contrast (WCAG AA, 4.5:1) checked for every text color on surface and background. */
const light: Palette = {
  background: '#F2F2F7',
  surface: '#FFFFFF',
  surfaceMuted: '#F7F7FA',
  text: '#111114',
  textMuted: '#5B5B66', // 6.4:1 on white
  primary: '#0058D6', // white text on it: 5.8:1
  primaryText: '#0058D6',
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
  onCamera: '#FFFFFF',
  onCameraMuted: 'rgba(255, 255, 255, 0.82)',
  glassFallback: 'rgba(20, 20, 24, 0.72)',
  glassTint: 'rgba(20, 20, 24, 0.35)',
  glassBorder: 'rgba(255, 255, 255, 0.14)',
  scrim: 'rgba(0, 0, 0, 0.55)',
  listening: '#34C759',
  hearing: '#FFD60A', // same yellow as the drawn boxes
  photoBackdrop: '#000000',
};

const dark: Palette = {
  background: '#000000',
  surface: '#1C1C1E',
  surfaceMuted: '#2C2C2E',
  text: '#F5F5F7', // 15.6:1 on surface
  textMuted: '#A1A1AA', // 6.6:1 on surface
  primary: '#1668DC', // white text on it: 5.2:1
  primaryText: '#4C9AFF', // 6.0:1 on surface
  onPrimary: '#FFFFFF',
  secondary: '#2C2C2E',
  onSecondary: '#F5F5F7',
  success: '#30D158',
  successSoft: 'rgba(48, 209, 88, 0.16)',
  warning: '#FFB340',
  warningSoft: 'rgba(255, 179, 64, 0.16)',
  danger: '#FF6961',
  dangerSoft: 'rgba(255, 105, 97, 0.16)',
  separator: 'rgba(84, 84, 88, 0.6)',
  border: 'rgba(120, 120, 128, 0.42)',
  onCamera: '#FFFFFF',
  onCameraMuted: 'rgba(255, 255, 255, 0.82)',
  glassFallback: 'rgba(28, 28, 30, 0.78)',
  glassTint: 'rgba(28, 28, 30, 0.4)',
  glassBorder: 'rgba(255, 255, 255, 0.16)',
  scrim: 'rgba(0, 0, 0, 0.62)',
  listening: '#30D158',
  hearing: '#FFD60A',
  photoBackdrop: '#000000',
};

export const palettes = { light, dark } as const;
export type ColorScheme = keyof typeof palettes;

export function paletteFor(scheme: string | null | undefined): Palette {
  return scheme === 'dark' ? dark : light;
}

/** Non-color tokens (the same in both modes). */
export const theme = {
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

export type Theme = typeof theme & { color: Palette; scheme: ColorScheme };

/** Tokens plus the palette for the current system appearance (light or dark). */
export function useTheme(): Theme {
  const scheme: ColorScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { ...theme, color: palettes[scheme], scheme };
}
