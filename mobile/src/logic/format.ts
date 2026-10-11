import type { MetricRule } from '../api/types';

export function formatReading(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** "128/82 mmHg · pulse 71 bpm" style summary for screens. */
export function summarizeReadings(readings: Record<string, number> | null | undefined, rules?: MetricRule[]): string {
  if (!readings) return '';
  const parts: string[] = [];
  const rest = { ...readings };
  if (rest.systolic !== undefined && rest.diastolic !== undefined) {
    parts.push(`${formatReading(rest.systolic)}/${formatReading(rest.diastolic)} mmHg`);
    delete rest.systolic;
    delete rest.diastolic;
  }
  for (const [name, value] of Object.entries(rest)) {
    const rule = rules?.find((r) => r.name === name);
    const label = rule?.label || name.replace(/_/g, ' ');
    const unit = rule?.unit ? ` ${rule.unit}` : '';
    parts.push(`${label} ${formatReading(value)}${unit}`);
  }
  return parts.join(' · ');
}

export function formatMicros(ns: number | null | undefined): string {
  if (ns === null || ns === undefined) return '–';
  return `${(ns / 1000).toFixed(1)} µs`;
}
