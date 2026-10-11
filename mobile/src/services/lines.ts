import VOICE_LINES from './voiceLines.json';

/** Fixed patient-facing lines shared with the backend (backend/app/voice_lines.py). */
export function lineText(id: string): string {
  return (VOICE_LINES as Record<string, string>)[id] ?? '';
}
