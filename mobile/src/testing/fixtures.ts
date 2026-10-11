import type { CaptureOut, ClinicalEvent, Protocol } from '../api/types';

export const protocol: Protocol = {
  protocol_id: 'p-1',
  title: 'Home blood pressure',
  prompt_text: 'Step 1: Check the blood pressure monitor.',
  validation_rules: {
    metrics: [
      { name: 'systolic', label: 'systolic', unit: 'mmHg', min: 90, max: 180, hard_min: 50, hard_max: 260, required: true },
      { name: 'diastolic', label: 'diastolic', unit: 'mmHg', min: 50, max: 110, hard_min: 30, hard_max: 160, required: true },
      { name: 'pulse', label: 'pulse', unit: 'bpm', min: 45, max: 120, hard_min: 25, hard_max: 220, required: false },
    ],
    cross_field: [{ type: 'greater_than', left: 'systolic', right: 'diastolic' }],
  },
  is_active: true,
  created_at: '2026-10-11T00:00:00Z',
};

export function capture(overrides: Partial<CaptureOut> = {}): CaptureOut {
  return {
    capture_id: 'c-1',
    status: 'needs_confirmation',
    reason: null,
    bounding_box: [280, 220, 720, 780],
    image_width: 768,
    image_height: 1024,
    readings: { systolic: 142, diastolic: 90 },
    flags: [],
    errors: [],
    voice_line_id: null,
    voice_script: 'I read 142 over 90. Is that right?',
    audio_url: null,
    ai_latency_ms: 900,
    validation_ns: 2100,
    ...overrides,
  };
}

export const event: ClinicalEvent = {
  event_id: 'e-1',
  protocol_id: 'p-1',
  patient_id: 'patient-demo-001',
  session_id: 's-1',
  capture_id: 'c-1',
  idempotency_key: 'k-1',
  status: 'accepted',
  extracted_data: { systolic: 142, diastolic: 90 },
  flags: [],
  validation_ns: 2100,
  timestamp: '2026-10-11T00:00:00Z',
};
