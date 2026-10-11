/**
 * Researcher portal (web). Rendering only: all behavior comes from usePortal().
 * Contract: docs/UI_CONTRACT.md §Portal.
 */
import { View } from 'react-native';

import { usePortal } from '../../hooks/usePortal';
import { formatMicros, summarizeReadings } from '../../logic/format';
import type { MetricDraft } from '../../logic/rulesForm';
import { AppText, Button, Card, Row, Screen, TextField, Toggle } from '../../ui/primitives';
import { theme } from '../../ui/theme';

const LIMIT_FIELDS: { field: keyof MetricDraft; label: string }[] = [
  { field: 'hard_min', label: 'Reject below' },
  { field: 'min', label: 'Flag below' },
  { field: 'max', label: 'Flag above' },
  { field: 'hard_max', label: 'Reject above' },
];

export function PortalScreen() {
  const portal = usePortal();
  const { draft } = portal;

  return (
    <Screen scroll testID="portal-screen">
      <AppText variant="hero">Gem · Researcher Portal</AppText>
      <AppText variant="small" tone={portal.connected ? 'muted' : 'danger'} testID="portal-connection">
        {portal.connected
          ? `Connected · AI: ${portal.health?.ai_mode ?? '…'}${portal.health?.ai_mode === 'gemini' ? ` (${portal.health.gemini_model})` : ''} · Voice: ${portal.health?.voice_enabled ? 'ElevenLabs' : 'on-device'}`
          : 'Cannot reach the Gem API. Is the backend running?'}
      </AppText>

      <Card testID="portal-editor">
        <AppText variant="title">New protocol step</AppText>
        <Button
          testID="portal-load-bp-preset"
          label="Use blood pressure template"
          variant="secondary"
          onPress={portal.loadBloodPressurePreset}
        />
        <TextField testID="portal-title-input" label="Title" value={draft.title} onChangeText={portal.setTitle} />
        <TextField
          testID="portal-prompt-input"
          label="Instructions (shown to the patient and given to the AI)"
          value={draft.promptText}
          onChangeText={portal.setPromptText}
          multiline
          placeholder="Step 1: Check the blood pressure monitor. Find the systolic value."
        />

        <AppText variant="body" style={{ marginTop: theme.space.md, fontWeight: '700' }}>
          Validation rules
        </AppText>
        <AppText variant="small" tone="muted">
          Values beyond the reject limits are treated as AI misreads and never stored. Values beyond the flag limits are
          stored and flagged for review.
        </AppText>
        {draft.rules.metrics.map((m, i) => (
          <Card key={i} testID={`portal-metric-${i}`} style={{ backgroundColor: theme.color.background }}>
            <Row>
              <TextField testID={`portal-metric-${i}-name`} label="Key" value={m.name} width={140}
                onChangeText={(v) => portal.updateMetric(i, 'name', v)} placeholder="systolic" />
              <TextField testID={`portal-metric-${i}-label`} label="Spoken name" value={m.label} width={140}
                onChangeText={(v) => portal.updateMetric(i, 'label', v)} />
              <TextField testID={`portal-metric-${i}-unit`} label="Unit" value={m.unit} width={90}
                onChangeText={(v) => portal.updateMetric(i, 'unit', v)} />
              {LIMIT_FIELDS.map(({ field, label }) => (
                <TextField key={field} testID={`portal-metric-${i}-${field}`} label={label} numeric width={110}
                  value={String(m[field])} onChangeText={(v) => portal.updateMetric(i, field, v)} />
              ))}
            </Row>
            <Row>
              <Toggle testID={`portal-metric-${i}-required`} label="Required" value={m.required}
                onChange={(v) => portal.updateMetric(i, 'required', v)} />
              <Button testID={`portal-metric-${i}-remove`} label="Remove" variant="secondary"
                onPress={() => portal.removeMetric(i)} />
            </Row>
          </Card>
        ))}
        <Button testID="portal-add-metric" label="Add metric" variant="secondary" onPress={portal.addMetric} />
        <Toggle
          testID="portal-cross-field"
          label="Systolic must be greater than diastolic"
          value={draft.rules.systolicAboveDiastolic}
          onChange={portal.setSystolicAboveDiastolic}
        />

        {portal.formErrors.length > 0 ? (
          <View testID="portal-form-errors">
            {portal.formErrors.map((e, i) => (
              <AppText key={i} tone="danger" variant="small">
                • {e}
              </AppText>
            ))}
          </View>
        ) : null}
        {portal.deployMessage ? (
          <AppText tone="success" testID="portal-deploy-message">
            {portal.deployMessage}
          </AppText>
        ) : null}
        <Button testID="portal-deploy" label="Deploy to patients" onPress={portal.deploy} loading={portal.deploying} />
      </Card>

      <Card testID="portal-protocols">
        <AppText variant="title">Protocols</AppText>
        {portal.protocols.length === 0 ? (
          <AppText tone="muted" testID="portal-protocols-empty">No protocols yet.</AppText>
        ) : null}
        {portal.protocols.map((p) => (
          <Row key={p.protocol_id} testID={`portal-protocol-${p.protocol_id}`} style={{ marginVertical: theme.space.xs }}>
            <AppText tone={p.is_active ? 'success' : 'muted'}>{p.is_active ? '● Active' : '○ Inactive'}</AppText>
            <AppText style={{ flexShrink: 1 }}>{p.title}</AppText>
            {p.is_active ? (
              <Button testID={`portal-deactivate-${p.protocol_id}`} label="Deactivate" variant="secondary"
                onPress={() => portal.deactivate(p.protocol_id)} />
            ) : (
              <Button testID={`portal-activate-${p.protocol_id}`} label="Activate" variant="secondary"
                onPress={() => portal.activate(p.protocol_id)} />
            )}
          </Row>
        ))}
      </Card>

      <Card testID="portal-gateway-metrics">
        <AppText variant="title">Deterministic gateway</AppText>
        <AppText testID="portal-latency">
          {portal.metrics && portal.metrics.validation.count > 0
            ? `Validation latency p50 ${portal.metrics.validation.p50_us} µs · p95 ${portal.metrics.validation.p95_us} µs · p99 ${portal.metrics.validation.p99_us} µs (n=${portal.metrics.validation.count})`
            : 'No validations yet.'}
        </AppText>
        <AppText tone="muted" variant="small">
          {`${portal.metrics?.events_stored ?? 0} readings stored · ${portal.rejections.length} AI readings blocked (latest 50)`}
        </AppText>
      </Card>

      <Card testID="portal-events">
        <AppText variant="title">Incoming readings</AppText>
        {portal.events.length === 0 ? (
          <AppText tone="muted" testID="portal-events-empty">No readings yet.</AppText>
        ) : null}
        {portal.events.map((e) => (
          <Row key={e.event_id} testID={`portal-event-${e.event_id}`}>
            <AppText tone={e.status === 'flagged' ? 'warning' : 'success'}>
              {e.status === 'flagged' ? '⚑ Flagged' : '✓ Accepted'}
            </AppText>
            <AppText>{summarizeReadings(e.extracted_data)}</AppText>
            <AppText variant="small" tone="muted">
              {`${new Date(e.timestamp).toLocaleString()} · ${e.patient_id} · gateway ${formatMicros(e.validation_ns)}`}
            </AppText>
          </Row>
        ))}
      </Card>

      <Card testID="portal-rejections">
        <AppText variant="title">Blocked by the gateway</AppText>
        {portal.rejections.length === 0 ? (
          <AppText tone="muted" testID="portal-rejections-empty">Nothing blocked.</AppText>
        ) : null}
        {portal.rejections.map((r) => (
          <View key={r.rejection_id} testID={`portal-rejection-${r.rejection_id}`} style={{ marginVertical: theme.space.xs }}>
            <AppText tone="danger">{r.errors.map((e) => e.message).join('; ')}</AppText>
            <AppText variant="small" tone="muted">
              {`${new Date(r.timestamp).toLocaleString()} · ${r.patient_id} · ${JSON.stringify(r.readings)}`}
            </AppText>
          </View>
        ))}
      </Card>
    </Screen>
  );
}
