/**
 * App configuration. Only non-secret values belong here: the bundle ships to phones.
 * All API keys live in backend/.env (zero-trust frontend).
 */

// The phone cannot reach "localhost" on your laptop. Set EXPO_PUBLIC_API_URL in
// mobile/.env to your laptop's LAN address (e.g. http://192.168.1.20:8000) or a tunnel URL.
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000').replace(/\/+$/, '');

// MVP non-goal: no auth. One hard-coded synthetic patient.
export const PATIENT_ID = 'patient-demo-001';

/** Client-side budget for POST /captures (server Gemini budget is 8 s). */
export const ANALYZE_TIMEOUT_MS = 15_000;
/** After this long the overlay switches to a "still working" message. */
export const SLOW_NOTICE_MS = 5_000;
export const DEFAULT_TIMEOUT_MS = 8_000;
/** If streamed ElevenLabs audio has not started by then, speak on-device instead. */
export const AUDIO_START_TIMEOUT_MS = 3_000;
/** Frames are downscaled by their long edge before upload (aspect ratio preserved). */
export const UPLOAD_LONG_EDGE_PX = 768;
export const UPLOAD_JPEG_QUALITY = 0.7;
