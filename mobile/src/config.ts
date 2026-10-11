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

// -- Gem assistant --------------------------------------------------------------
/** One camera frame per second goes to the session's context window. */
export const FRAME_INTERVAL_MS = 1_000;
export const FRAME_LONG_EDGE_PX = 768;
export const FRAME_JPEG_QUALITY = 0.6;
export const FRAME_TIMEOUT_MS = 5_000;
/** Gemini budget is 20 s server-side; leave room for upload. */
export const TURN_TIMEOUT_MS = 30_000;
/** Microphone capture rate requested from expo-audio; resampled to 16 kHz if different. */
export const MIC_SAMPLE_RATE = 16_000;
/** Answer audio players kept in RAM for instant replays. */
export const ANSWER_AUDIO_CACHE_SIZE = 5;

// -- Researcher portal: study documents ---------------------------------------------------
export const UPLOAD_TIMEOUT_MS = 120_000;
/** Must match the backend limit (GEM max_document_bytes). */
export const MAX_DOCUMENT_BYTES = 20_000_000;
export const DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
