/**
 * Researcher portal form model: editable strings <-> ValidationRules, with the same
 * ordering checks the backend enforces (hard_min <= min <= max <= hard_max).
 */
import type { ValidationRules } from '../api/types';

export interface MetricDraft {
  name: string;
  label: string;
  unit: string;
  min: string;
  max: string;
  hard_min: string;
  hard_max: string;
  required: boolean;
}

export interface RulesDraft {
  metrics: MetricDraft[];
  systolicAboveDiastolic: boolean;
}

export function emptyMetric(): MetricDraft {
  return { name: '', label: '', unit: '', min: '', max: '', hard_min: '', hard_max: '', required: true };
}

export function draftFromRules(rules: ValidationRules): RulesDraft {
  return {
    metrics: rules.metrics.map((m) => ({
      name: m.name,
      label: m.label,
      unit: m.unit,
      min: String(m.min),
      max: String(m.max),
      hard_min: String(m.hard_min),
      hard_max: String(m.hard_max),
      required: m.required,
    })),
    systolicAboveDiastolic: rules.cross_field.some(
      (r) => r.type === 'greater_than' && r.left === 'systolic' && r.right === 'diastolic',
    ),
  };
}

const NAME = /^[a-z][a-z0-9_]{0,31}$/;

function num(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export type DraftResult = { ok: true; rules: ValidationRules } | { ok: false; errors: string[] };

export function rulesFromDraft(draft: RulesDraft): DraftResult {
  const errors: string[] = [];
  if (draft.metrics.length === 0) errors.push('Add at least one metric.');
  const seen = new Set<string>();
  const metrics = draft.metrics.map((m, i) => {
    const row = `Metric ${i + 1}`;
    const name = m.name.trim();
    if (!NAME.test(name)) errors.push(`${row}: name must be lowercase letters, digits or _ (e.g. systolic).`);
    if (seen.has(name)) errors.push(`${row}: duplicate name "${name}".`);
    seen.add(name);
    const [min, max, hardMin, hardMax] = [num(m.min), num(m.max), num(m.hard_min), num(m.hard_max)];
    if (min === null || max === null || hardMin === null || hardMax === null) {
      errors.push(`${row}: all four limits must be numbers.`);
    } else if (!(hardMin <= min && min <= max && max <= hardMax)) {
      errors.push(`${row}: limits must satisfy hard min ≤ min ≤ max ≤ hard max.`);
    }
    return {
      name,
      label: m.label.trim(),
      unit: m.unit.trim(),
      min: min ?? 0,
      max: max ?? 0,
      hard_min: hardMin ?? 0,
      hard_max: hardMax ?? 0,
      required: m.required,
    };
  });
  const crossField: ValidationRules['cross_field'] = [];
  if (draft.systolicAboveDiastolic) {
    if (seen.has('systolic') && seen.has('diastolic')) {
      crossField.push({ type: 'greater_than', left: 'systolic', right: 'diastolic' });
    } else {
      errors.push('"Systolic > diastolic" needs metrics named systolic and diastolic.');
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, rules: { metrics, cross_field: crossField } };
}
