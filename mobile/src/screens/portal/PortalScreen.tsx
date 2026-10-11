/**
 * Researcher portal (web). Rendering only: all behavior comes from usePortal().
 * Contract: docs/UI_CONTRACT.md §Portal.
 *
 * Grouped settings-style layout (apple-design): a centered column, section headers,
 * white cards with hairline separators. No decorative motion: researchers use this
 * many times a day, so state changes are instant.
 */
import { StyleSheet, View } from 'react-native';

import { usePortal } from '../../hooks/usePortal';
import { formatMicros, summarizeReadings } from '../../logic/format';
import type { MetricDraft } from '../../logic/rulesForm';
import {
  AppText,
  Button,
  Card,
  Ionicons,
  Pill,
  Row,
  Screen,
  SectionHeader,
  TextField,
  Toggle,
  type IconName,
} from '../../ui/primitives';
import { theme, useTheme } from '../../ui/theme';

const LIMIT_FIELDS: { field: keyof MetricDraft; label: string }[] = [
  { field: 'hard_min', label: 'Reject below' },
  { field: 'min', label: 'Flag below' },
  { field: 'max', label: 'Flag above' },
  { field: 'hard_max', label: 'Reject above' },
];

const DOC_ICON: Record<string, IconName> = { note: 'document-text-outline', pdf: 'document-outline', image: 'image-outline' };

function Separator() {
  const { color } = useTheme();
  return <View style={[styles.separator, { backgroundColor: color.separator }]} />;
}

export function PortalScreen() {
  const { color } = useTheme();
  const portal = usePortal();
  const { draft } = portal;

  return (
    <Screen scroll testID="portal-screen">
      <View style={styles.column}>
        <View style={styles.header}>
          <View style={[styles.logo, { backgroundColor: color.primary }]}>
            <Ionicons name="sparkles" size={22} color={color.onPrimary} />
          </View>
          <View style={{ flex: 1, minWidth: 220 }}>
            <AppText variant="hero">Gem</AppText>
            <AppText variant="body" tone="muted">
              Researcher portal
            </AppText>
          </View>
          <View testID="portal-connection" style={[styles.connection, { backgroundColor: portal.connected ? color.surface : color.dangerSoft, borderColor: color.separator }]}>
            <View style={[styles.connectionDot, { backgroundColor: portal.connected ? color.success : color.danger }]} />
            <AppText variant="small" tone={portal.connected ? 'muted' : 'danger'} weight="500">
              {portal.connected
                ? `Connected · AI: ${portal.health?.ai_mode ?? '…'}${portal.health?.ai_mode === 'gemini' ? ` (${portal.health.gemini_model})` : ''} · Voice: ${portal.health?.voice_enabled ? 'ElevenLabs' : 'on-device'}`
                : 'Cannot reach the Gem API. Is the backend running?'}
            </AppText>
          </View>
        </View>

        {/* ---------------- Gem assistant ---------------- */}
        <SectionHeader title="Gem assistant" subtitle="How the patient app behaves." />

        <Card testID="portal-settings">
          <AppText variant="body" weight="600">
            Inactivity
          </AppText>
          <AppText variant="small" tone="muted">
            When nobody moves the phone, speaks or changes the view, Gem stops capturing frames, then forgets the
            conversation. Applies to Gem sessions started after saving.
          </AppText>
          <Row style={styles.fields}>
            <TextField
              testID="portal-idle-minutes"
              label="Pause camera after"
              value={portal.idleMinutes}
              onChangeText={portal.setIdleMinutes}
              numeric
              suffix="min"
              width={190}
            />
            <TextField
              testID="portal-purge-minutes"
              label="Forget conversation after"
              value={portal.purgeMinutes}
              onChangeText={portal.setPurgeMinutes}
              numeric
              suffix="min"
              width={190}
            />
          </Row>
          <Row style={styles.actions}>
            <Button
              testID="portal-settings-save"
              label="Save"
              compact
              onPress={portal.saveSettings}
              loading={portal.settingsSaving}
            />
            {portal.settingsMessage ? (
              <AppText variant="small" tone="success" testID="portal-settings-message">
                {portal.settingsMessage}
              </AppText>
            ) : null}
            {portal.settingsError ? (
              <AppText variant="small" tone="danger" testID="portal-settings-error">
                {portal.settingsError}
              </AppText>
            ) : null}
          </Row>
        </Card>

        {/* ---------------- Protocols ---------------- */}
        <SectionHeader title="Protocols" subtitle="Patients and Gem use the active protocol and its study context. Add one under New protocol." />

        <Card testID="portal-protocols">
          {portal.protocols.length === 0 ? (
            <AppText tone="muted" testID="portal-protocols-empty" style={styles.empty}>
              No protocols yet. Create one under New protocol below.
            </AppText>
          ) : null}
          {portal.protocols.map((p, i) => (
            <View key={p.protocol_id}>
              {i > 0 ? <Separator /> : null}
              <View testID={`portal-protocol-${p.protocol_id}`} style={styles.listRow}>
                <View style={{ flex: 1, gap: 4 }}>
                  <AppText weight="500">{p.title}</AppText>
                  <Pill label={p.is_active ? 'Active' : 'Inactive'} icon={p.is_active ? 'radio-button-on' : 'radio-button-off'} tone={p.is_active ? 'success' : 'neutral'} />
                </View>
                {p.is_active ? (
                  <Button
                    testID={`portal-deactivate-${p.protocol_id}`}
                    label="Deactivate"
                    variant="secondary"
                    compact
                    onPress={() => portal.deactivate(p.protocol_id)}
                  />
                ) : (
                  <Button
                    testID={`portal-activate-${p.protocol_id}`}
                    label="Activate"
                    variant="secondary"
                    compact
                    onPress={() => portal.activate(p.protocol_id)}
                  />
                )}
              </View>
            </View>
          ))}
        </Card>

        <Card testID="portal-documents">
          <AppText variant="body" weight="600">
            Study context
          </AppText>
          {portal.documentsProtocol ? (
            <>
              <AppText variant="small" tone="muted" testID="portal-documents-protocol">
                {`For the active protocol, ${portal.documentsProtocol.title}. Gem reads these notes, photos and PDFs (manuals, instructions) before answering patients; new Gem sessions use them.`}
              </AppText>
              <View style={styles.list}>
                {portal.documents.length === 0 ? (
                  <AppText tone="muted" testID="portal-documents-empty" style={styles.empty}>
                    No study documents yet.
                  </AppText>
                ) : null}
                {portal.documents.map((d, i) => (
                  <View key={d.doc_id}>
                    {i > 0 ? <Separator /> : null}
                    <View testID={`portal-document-${d.doc_id}`} style={styles.listRow}>
                      <Ionicons name={DOC_ICON[d.kind] ?? 'document-outline'} size={22} color={color.primaryText} />
                      <View style={{ flex: 1 }}>
                        <AppText weight="500">{d.title}</AppText>
                        <AppText variant="small" tone="muted">
                          {`${d.kind.toUpperCase()} · ${Math.max(1, Math.round(d.size_bytes / 1000))} KB · ${
                            d.kind === 'note' || d.uploaded_to_gemini
                              ? 'ready for Gem'
                              : portal.health?.ai_mode === 'gemini'
                                ? 'uploading to Gemini…'
                                : 'stored (offline mode)'
                          }`}
                        </AppText>
                      </View>
                      <Button
                        testID={`portal-document-delete-${d.doc_id}`}
                        label="Remove"
                        variant="danger"
                        compact
                        onPress={() => portal.deleteDocument(d.doc_id)}
                        disabled={portal.documentsBusy}
                      />
                    </View>
                  </View>
                ))}
              </View>
              <TextField
                testID="portal-note-title"
                label="Note title"
                value={portal.noteTitle}
                onChangeText={portal.setNoteTitle}
                placeholder="About this study"
              />
              <TextField
                testID="portal-note-text"
                label="Note"
                value={portal.noteText}
                onChangeText={portal.setNoteText}
                multiline
                placeholder="What the study is about, what data is collected, which device patients use…"
              />
              <Row style={styles.actions}>
                <Button testID="portal-note-add" label="Add note" icon="add" compact onPress={portal.addNote} loading={portal.documentsBusy} />
                <Button
                  testID="portal-upload-file"
                  label="Upload PDF or image"
                  icon="cloud-upload-outline"
                  variant="secondary"
                  compact
                  onPress={portal.uploadFile}
                  disabled={portal.documentsBusy}
                />
              </Row>
            </>
          ) : (
            <AppText tone="muted" testID="portal-documents-no-protocol" style={styles.empty}>
              Activate a protocol to add study documents. Gem reads them (notes, photos, PDF manuals) before
              answering patients.
            </AppText>
          )}
          {portal.documentsError ? (
            <AppText tone="danger" variant="small" testID="portal-documents-error">
              {portal.documentsError}
            </AppText>
          ) : null}
        </Card>

        <Card testID="portal-editor">
          <Row style={{ justifyContent: 'space-between' }}>
            <AppText variant="body" weight="600">
              New protocol
            </AppText>
            <Button
              testID="portal-load-bp-preset"
              label="Use blood pressure template"
              variant="plain"
              compact
              onPress={portal.loadBloodPressurePreset}
            />
          </Row>
          <AppText variant="small" tone="muted">
            Creating a protocol makes it the active one (only one is active at a time). Add its study context above
            once it is created.
          </AppText>
          <TextField testID="portal-title-input" label="Title" value={draft.title} onChangeText={portal.setTitle} />
          <TextField
            testID="portal-prompt-input"
            label="Instructions (shown to the patient and given to the AI)"
            value={draft.promptText}
            onChangeText={portal.setPromptText}
            multiline
            placeholder="Step 1: Check the blood pressure monitor. Find the systolic value."
          />

          <AppText variant="body" weight="600" style={{ marginTop: theme.space.md }}>
            Validation rules
          </AppText>
          <AppText variant="small" tone="muted">
            Values beyond the reject limits are treated as AI misreads and never stored. Values beyond the flag limits
            are stored and flagged for review.
          </AppText>
          {draft.rules.metrics.map((m, i) => (
            <View key={i} testID={`portal-metric-${i}`} style={[styles.metric, { backgroundColor: color.surfaceMuted }]}>
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
              <Row style={{ justifyContent: 'space-between' }}>
                <Toggle testID={`portal-metric-${i}-required`} label="Required" value={m.required}
                  onChange={(v) => portal.updateMetric(i, 'required', v)} />
                <Button testID={`portal-metric-${i}-remove`} label="Remove" variant="danger" compact
                  onPress={() => portal.removeMetric(i)} />
              </Row>
            </View>
          ))}
          <Row style={{ justifyContent: 'space-between' }}>
            <Button testID="portal-add-metric" label="Add metric" icon="add" variant="secondary" compact onPress={portal.addMetric} />
            <Toggle
              testID="portal-cross-field"
              label="Systolic must be greater than diastolic"
              value={draft.rules.systolicAboveDiastolic}
              onChange={portal.setSystolicAboveDiastolic}
            />
          </Row>

          {portal.formErrors.length > 0 ? (
            <View testID="portal-form-errors" style={[styles.errors, { backgroundColor: color.dangerSoft }]}>
              {portal.formErrors.map((e, i) => (
                <AppText key={i} tone="danger" variant="small">
                  • {e}
                </AppText>
              ))}
            </View>
          ) : null}
          {portal.deployMessage ? (
            <AppText tone="success" variant="small" testID="portal-deploy-message">
              {portal.deployMessage}
            </AppText>
          ) : null}
          <Button testID="portal-deploy" label="Create and activate" onPress={portal.deploy} loading={portal.deploying} style={styles.actions} />
        </Card>

        {/* ---------------- Gateway ---------------- */}
        <SectionHeader title="Readings" subtitle="Values checked by the deterministic gateway (legacy capture flow)." />

        <Card testID="portal-gateway-metrics">
          <Row style={{ gap: theme.space.lg }}>
            <Stat label="Readings stored" value={String(portal.metrics?.events_stored ?? 0)} />
            <Stat label="AI readings blocked" value={String(portal.rejections.length)} hint="latest 50" />
          </Row>
          <AppText variant="small" tone="muted" testID="portal-latency" style={{ marginTop: theme.space.sm }}>
            {portal.metrics && portal.metrics.validation.count > 0
              ? `Validation latency p50 ${portal.metrics.validation.p50_us} µs · p95 ${portal.metrics.validation.p95_us} µs · p99 ${portal.metrics.validation.p99_us} µs (n=${portal.metrics.validation.count})`
              : 'No validations yet.'}
          </AppText>
        </Card>

        <Card testID="portal-events">
          <AppText variant="body" weight="600">
            Incoming
          </AppText>
          {portal.events.length === 0 ? (
            <AppText tone="muted" testID="portal-events-empty" style={styles.empty}>
              No readings yet.
            </AppText>
          ) : null}
          {portal.events.map((e, i) => (
            <View key={e.event_id}>
              {i > 0 ? <Separator /> : null}
              <View testID={`portal-event-${e.event_id}`} style={styles.listRow}>
                <Pill
                  label={e.status === 'flagged' ? 'Flagged' : 'Accepted'}
                  icon={e.status === 'flagged' ? 'flag' : 'checkmark'}
                  tone={e.status === 'flagged' ? 'warning' : 'success'}
                />
                <View style={{ flex: 1 }}>
                  <AppText weight="500">{summarizeReadings(e.extracted_data)}</AppText>
                  <AppText variant="small" tone="muted">
                    {`${new Date(e.timestamp).toLocaleString()} · ${e.patient_id} · gateway ${formatMicros(e.validation_ns)}`}
                  </AppText>
                </View>
              </View>
            </View>
          ))}
        </Card>

        <Card testID="portal-rejections">
          <AppText variant="body" weight="600">
            Blocked by the gateway
          </AppText>
          {portal.rejections.length === 0 ? (
            <AppText tone="muted" testID="portal-rejections-empty" style={styles.empty}>
              Nothing blocked.
            </AppText>
          ) : null}
          {portal.rejections.map((r, i) => (
            <View key={r.rejection_id}>
              {i > 0 ? <Separator /> : null}
              <View testID={`portal-rejection-${r.rejection_id}`} style={styles.listRow}>
                <Ionicons name="close-circle" size={22} color={color.danger} />
                <View style={{ flex: 1 }}>
                  <AppText tone="danger" weight="500">
                    {r.errors.map((e) => e.message).join('; ')}
                  </AppText>
                  <AppText variant="small" tone="muted">
                    {`${new Date(r.timestamp).toLocaleString()} · ${r.patient_id} · ${JSON.stringify(r.readings)}`}
                  </AppText>
                </View>
              </View>
            </View>
          ))}
        </Card>
      </View>
    </Screen>
  );
}

function Stat(props: { label: string; value: string; hint?: string }) {
  return (
    <View>
      <AppText variant="hero">{props.value}</AppText>
      <AppText variant="small" tone="muted">
        {props.hint ? `${props.label} (${props.hint})` : props.label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { width: '100%', maxWidth: theme.content.maxWidth, alignSelf: 'center' },
  header: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.md,
    paddingTop: theme.space.lg,
    paddingBottom: theme.space.sm,
  },
  logo: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 1,
  },
  connectionDot: { width: 8, height: 8, borderRadius: 4 },
  fields: { alignItems: 'flex-end', marginTop: theme.space.xs },
  list: { marginVertical: theme.space.xs },
  /** The closing (blue) action of a card gets room above it. */
  actions: { marginTop: theme.space.md },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md, paddingVertical: theme.space.sm },
  separator: { height: StyleSheet.hairlineWidth },
  empty: { paddingVertical: theme.space.sm },
  metric: {
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    marginVertical: theme.space.sm,
    gap: theme.space.xs,
  },
  errors: { borderRadius: theme.radius.sm, padding: theme.space.sm, marginVertical: theme.space.sm },
});
