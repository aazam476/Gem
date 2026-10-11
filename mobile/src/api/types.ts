// Mirrors backend/app/schemas.py and backend/app/rules.py. See docs/API_CONTRACT.md.

export interface MetricRule {
  name: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  hard_min: number;
  hard_max: number;
  required: boolean;
}

export interface CrossFieldRule {
  type: 'greater_than';
  left: string;
  right: string;
}

export interface ValidationRules {
  metrics: MetricRule[];
  cross_field: CrossFieldRule[];
}

export interface Protocol {
  protocol_id: string;
  title: string;
  prompt_text: string;
  validation_rules: ValidationRules;
  is_active: boolean;
  created_at: string;
}

export interface ProtocolCreate {
  title: string;
  prompt_text: string;
  validation_rules: ValidationRules;
  activate: boolean;
}

export interface Issue {
  code: string;
  metric: string | null;
  message: string;
}

/** [ymin, xmin, ymax, xmax], each normalized to 0-1000. */
export type BoundingBox = [number, number, number, number];

export type CaptureStatus = 'needs_confirmation' | 'unreadable' | 'rejected';

export interface CaptureOut {
  capture_id: string;
  status: CaptureStatus;
  reason: string | null;
  bounding_box: BoundingBox | null;
  image_width: number;
  image_height: number;
  readings: Record<string, number> | null;
  flags: Issue[];
  errors: Issue[];
  voice_line_id: string | null;
  voice_script: string;
  audio_url: string | null;
  ai_latency_ms: number;
  validation_ns: number | null;
}

export interface ClinicalEvent {
  event_id: string;
  protocol_id: string;
  patient_id: string;
  session_id: string;
  capture_id: string | null;
  idempotency_key: string;
  status: 'accepted' | 'flagged';
  extracted_data: Record<string, number>;
  flags: Issue[];
  validation_ns: number;
  timestamp: string;
}

export interface IngestResponse {
  result: 'accepted' | 'flagged';
  event: ClinicalEvent;
  validation_ns: number;
  voice_line_id: 'saved' | 'saved_flagged';
  voice_script: string;
}

export interface Rejection {
  rejection_id: string;
  protocol_id: string;
  patient_id: string;
  session_id: string;
  capture_id: string | null;
  idempotency_key: string | null;
  readings: unknown;
  errors: Issue[];
  validation_ns: number;
  timestamp: string;
}

export interface ErrorBody {
  error: string;
  message: string;
  errors?: Issue[];
  event?: ClinicalEvent | null;
  voice_line_id?: string | null;
  voice_script?: string | null;
}

export interface LatencySummary {
  count: number;
  p50_us: number;
  p95_us: number;
  p99_us: number;
  max_us: number;
  mean_us: number;
}

export interface GatewayMetrics {
  validation: LatencySummary;
  events_stored: number;
}

export interface Health {
  status: 'ok';
  ai_mode: 'gemini' | 'mock';
  voice_enabled: boolean;
  gemini_model: string;
  active_protocol_id: string | null;
}

// -- Gem assistant (docs/API_CONTRACT.md §Assistant) --------------------------------

export interface AssistantSession {
  session_id: string;
  idle_timeout_s: number;
  expires_in_s: number;
  frame_interval_ms: number;
  frames_buffered: number;
  frames_received: number;
  turns: number;
  study_context: boolean;
}

export interface FrameAck {
  frames_buffered: number;
  frames_received: number;
  /** 0 = same as previous frame, 1 = completely different; null for the first frame. */
  change_score: number | null;
  expires_in_s: number;
}

export type TurnInput = { audio_base64: string; audio_mime: 'audio/wav' } | { text: string };

export interface TurnOut {
  turn_id: string;
  status: 'answered' | 'ignored';
  transcript: string;
  answer: string;
  annotations: { label: string; box_2d: [number, number, number, number] }[];
  image_url: string | null;
  image_width: number;
  image_height: number;
  audio_url: string | null;
  frames_used: number;
  latency_ms: number;
}
