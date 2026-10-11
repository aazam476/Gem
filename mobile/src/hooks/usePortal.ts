/**
 * All researcher-portal logic: author a protocol, deploy it, watch results arrive.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, api } from '../api/client';
import type { ClinicalEvent, GatewayMetrics, Health, Protocol, Rejection, StudyDocument } from '../api/types';
import { PickError, pickStudyFile } from '../services/pickFile';
import { draftFromRules, emptyMetric, rulesFromDraft, type MetricDraft, type RulesDraft } from '../logic/rulesForm';

export const POLL_MS = 4000;

export interface ProtocolDraft {
  title: string;
  promptText: string;
  rules: RulesDraft;
}

export interface PortalController {
  health: Health | null;
  connected: boolean;
  protocols: Protocol[];
  activeProtocol: Protocol | null;
  events: ClinicalEvent[];
  rejections: Rejection[];
  metrics: GatewayMetrics | null;

  /** Protocol whose study documents are shown (defaults to the active one). */
  documentsProtocol: Protocol | null;
  documents: StudyDocument[];
  noteTitle: string;
  noteText: string;
  documentsBusy: boolean;
  documentsError: string | null;
  setNoteTitle: (v: string) => void;
  setNoteText: (v: string) => void;
  selectDocumentsProtocol: (protocolId: string) => void;
  addNote: () => void;
  uploadFile: () => void;
  deleteDocument: (docId: string) => void;

  draft: ProtocolDraft;
  formErrors: string[];
  deploying: boolean;
  deployMessage: string | null;

  setTitle: (v: string) => void;
  setPromptText: (v: string) => void;
  updateMetric: (index: number, field: keyof MetricDraft, value: string | boolean) => void;
  addMetric: () => void;
  removeMetric: (index: number) => void;
  setSystolicAboveDiastolic: (v: boolean) => void;
  loadBloodPressurePreset: () => void;
  deploy: () => void;
  activate: (protocolId: string) => void;
  deactivate: (protocolId: string) => void;
  refresh: () => void;
}

const BP_PROMPT = 'Step 1: Check the blood pressure monitor. Find the systolic, diastolic and pulse values.';

export function blankDraft(): ProtocolDraft {
  return { title: '', promptText: '', rules: { metrics: [emptyMetric()], systolicAboveDiastolic: false } };
}

export function usePortal(): PortalController {
  const [health, setHealth] = useState<Health | null>(null);
  const [connected, setConnected] = useState(true);
  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [events, setEvents] = useState<ClinicalEvent[]>([]);
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const [metrics, setMetrics] = useState<GatewayMetrics | null>(null);
  const [draft, setDraft] = useState<ProtocolDraft>(blankDraft);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployMessage, setDeployMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const [selectedDocsProtocol, setSelectedDocsProtocol] = useState<string | null>(null);
  const [documents, setDocuments] = useState<StudyDocument[]>([]);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteText, setNoteText] = useState('');
  const [documentsBusy, setDocumentsBusy] = useState(false);
  const [documentsError, setDocumentsError] = useState<string | null>(null);

  const documentsProtocol =
    protocols.find((p) => p.protocol_id === selectedDocsProtocol) ?? protocols.find((p) => p.is_active) ?? null;
  const docsProtocolId = documentsProtocol?.protocol_id ?? null;

  const loadDocuments = useCallback((protocolId: string | null) => {
    if (!protocolId) return; // nothing to show; the card asks for a protocol first
    api
      .listDocuments(protocolId)
      .then((d) => mounted.current && setDocuments(d))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadDocuments(docsProtocolId);
    // Keep polling so "preparing" turns into "ready for Gem" once Gemini has the file.
    const timer = setInterval(() => loadDocuments(docsProtocolId), POLL_MS);
    return () => clearInterval(timer);
  }, [docsProtocolId, loadDocuments]);

  const runDocumentAction = useCallback(
    (action: () => Promise<unknown>) => {
      if (!docsProtocolId) {
        setDocumentsError('Create and deploy a protocol first.');
        return;
      }
      setDocumentsBusy(true);
      setDocumentsError(null);
      action()
        .then(() => loadDocuments(docsProtocolId))
        .catch((err: unknown) => {
          if (!mounted.current) return;
          setDocumentsError(err instanceof Error ? err.message : 'Something went wrong.');
        })
        .finally(() => mounted.current && setDocumentsBusy(false));
    },
    [docsProtocolId, loadDocuments],
  );

  const refresh = useCallback(() => {
    Promise.all([api.health(), api.listProtocols(), api.listEvents(), api.listRejections(), api.gatewayMetrics()])
      .then(([h, p, e, r, m]) => {
        if (!mounted.current) return;
        setHealth(h);
        setProtocols(p);
        setEvents(e);
        setRejections(r);
        setMetrics(m);
        setConnected(true);
      })
      .catch(() => {
        if (mounted.current) setConnected(false);
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const editRules = (fn: (rules: RulesDraft) => RulesDraft) => setDraft((d) => ({ ...d, rules: fn(d.rules) }));

  const loadBloodPressurePreset = useCallback(() => {
    api
      .bloodPressurePreset()
      .then((rules) =>
        setDraft((d) => ({
          title: d.title || 'Home blood pressure',
          promptText: d.promptText || BP_PROMPT,
          rules: draftFromRules(rules),
        })),
      )
      .catch(() => setConnected(false));
  }, []);

  const deploy = useCallback(() => {
    if (deploying) return;
    const errors: string[] = [];
    if (!draft.title.trim()) errors.push('Give the protocol a title.');
    if (!draft.promptText.trim()) errors.push('Write the instructions for this step.');
    const parsed = rulesFromDraft(draft.rules);
    if (!parsed.ok) errors.push(...parsed.errors);
    setFormErrors(errors);
    if (errors.length || !parsed.ok) return;
    setDeploying(true);
    setDeployMessage(null);
    api
      .createProtocol({
        title: draft.title.trim(),
        prompt_text: draft.promptText.trim(),
        validation_rules: parsed.rules,
        activate: true,
      })
      .then((p) => {
        setDeployMessage(`Deployed "${p.title}". Patients will get it on their next capture.`);
        refresh();
      })
      .catch((err: unknown) => {
        const detail =
          err instanceof ApiError ? (err.body.errors ?? []).map((e) => `${e.metric}: ${e.message}`) : [];
        setFormErrors([err instanceof Error ? err.message : 'Deploy failed.', ...detail]);
      })
      .finally(() => setDeploying(false));
  }, [deploying, draft, refresh]);

  const activate = useCallback(
    (id: string) => void api.activateProtocol(id).then(refresh, () => setConnected(false)),
    [refresh],
  );
  const deactivate = useCallback(
    (id: string) => void api.deactivateProtocol(id).then(refresh, () => setConnected(false)),
    [refresh],
  );

  return {
    documentsProtocol,
    documents,
    noteTitle,
    noteText,
    documentsBusy,
    documentsError,
    setNoteTitle,
    setNoteText,
    selectDocumentsProtocol: setSelectedDocsProtocol,
    addNote: () => {
      if (!noteTitle.trim() || !noteText.trim()) {
        setDocumentsError('Give the note a title and some text.');
        return;
      }
      runDocumentAction(async () => {
        await api.addNote(docsProtocolId!, noteTitle.trim(), noteText.trim());
        setNoteTitle('');
        setNoteText('');
      });
    },
    uploadFile: () =>
      runDocumentAction(async () => {
        let picked;
        try {
          picked = await pickStudyFile();
        } catch (err) {
          throw err instanceof PickError ? err : new Error('Could not open that file.');
        }
        if (!picked) return; // cancelled
        await api.addFile(docsProtocolId!, { ...picked, title: picked.filename });
      }),
    deleteDocument: (docId: string) => runDocumentAction(() => api.deleteDocument(docsProtocolId!, docId)),
    health,
    connected,
    protocols,
    activeProtocol: protocols.find((p) => p.is_active) ?? null,
    events,
    rejections,
    metrics,
    draft,
    formErrors,
    deploying,
    deployMessage,
    setTitle: (v) => setDraft((d) => ({ ...d, title: v })),
    setPromptText: (v) => setDraft((d) => ({ ...d, promptText: v })),
    updateMetric: (index, field, value) =>
      editRules((r) => ({
        ...r,
        metrics: r.metrics.map((m, i) => (i === index ? { ...m, [field]: value } : m)),
      })),
    addMetric: () => editRules((r) => ({ ...r, metrics: [...r.metrics, emptyMetric()] })),
    removeMetric: (index) => editRules((r) => ({ ...r, metrics: r.metrics.filter((_, i) => i !== index) })),
    setSystolicAboveDiastolic: (v) => editRules((r) => ({ ...r, systolicAboveDiastolic: v })),
    loadBloodPressurePreset,
    deploy,
    activate,
    deactivate,
    refresh,
  };
}
