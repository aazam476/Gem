import type { ClinicalEvent, Protocol, TurnOut } from '../api/types';

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

export function turn(overrides: Partial<TurnOut> = {}): TurnOut {
  return {
    turn_id: 't-1',
    status: 'answered',
    transcript: 'where is the start button',
    answer: 'It is the blue button at the bottom.',
    annotations: [{ label: 'start', box_2d: [700, 400, 900, 600] }],
    image_url: '/sessions/s-1/turns/t-1/image',
    image_width: 768,
    image_height: 576,
    frame_id: 12,
    frame_age_s: 0.4,
    audio_url: null,
    frames_used: 3,
    latency_ms: 1200,
    ...overrides,
  };
}
