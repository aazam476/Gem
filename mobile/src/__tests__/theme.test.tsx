/** Light/dark mode: palette selection, readable contrast in both, screens follow the system. */
import { render, renderHook, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AnswerSheet } from '../screens/assistant/AnswerSheet';
import { palettes, paletteFor, useTheme, type Palette } from '../ui/theme';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: jest.fn(() => 'light') }));
const mockScheme = jest.requireMock('react-native/Libraries/Utilities/useColorScheme').default as jest.Mock;

afterEach(() => mockScheme.mockReturnValue('light'));

describe.each(['light', 'dark'] as const)('%s palette', (scheme) => {
  const c: Palette = palettes[scheme];
  it.each(['text', 'textMuted', 'primaryText', 'success', 'warning', 'danger'] as const)(
    '%s is readable (WCAG AA) on surface and background',
    (token) => {
      expect(contrast(c[token], c.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c[token], c.background)).toBeGreaterThanOrEqual(4.5);
    },
  );
  it('button labels are readable', () => {
    expect(contrast(c.onPrimary, c.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.onSecondary, c.secondary)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('useTheme', () => {
  it.each([
    ['light', palettes.light],
    ['dark', palettes.dark],
    [null, palettes.light],
  ] as const)('system %s', async (system, expected) => {
    mockScheme.mockReturnValue(system);
    const { result } = await renderHook(() => useTheme());
    expect(result.current.color).toBe(expected);
    expect(paletteFor(system)).toBe(expected);
  });

  it('the answer sheet follows dark mode', async () => {
    mockScheme.mockReturnValue('dark');
    await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
        <AnswerSheet
          answer={{ turnId: 't', transcript: 'q', answer: 'a', imageUri: null, imageWidth: 0, imageHeight: 0, frameAgeS: 0, audioUrl: null }}
          phase="listening"
          speaking={false}
          onReplay={jest.fn()}
          onDismiss={jest.fn()}
        />
      </SafeAreaProvider>,
    );
    const sheet = screen.getByTestId('assistant-answer-text');
    expect(StyleSheet.flatten(sheet.props.style).color).toBe(palettes.dark.text);
  });
});
