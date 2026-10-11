import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';

import { api } from '../api/client';
import { formatMinutes, parseMinutes, usePortal } from '../hooks/usePortal';

jest.mock('../api/client', () => {
  const actual = jest.requireActual('../api/client');
  return {
    ...actual,
    api: {
      health: jest.fn(async () => ({ status: 'ok', ai_mode: 'mock', voice_enabled: false, gemini_model: 'g', active_protocol_id: 'p-1' })),
      listProtocols: jest.fn(async () => [jest.requireActual('../testing/fixtures').protocol]),
      listEvents: jest.fn(async () => []),
      listRejections: jest.fn(async () => []),
      gatewayMetrics: jest.fn(async () => ({ validation: { count: 0 }, events_stored: 0 })),
      listDocuments: jest.fn(async () => []),
      addNote: jest.fn(async () => ({})),
      addFile: jest.fn(async () => ({})),
      deleteDocument: jest.fn(async () => null),
      getAssistantSettings: jest.fn(async () => ({ idle_after_s: 60, purge_after_s: 600 })),
      saveAssistantSettings: jest.fn(async (s: unknown) => s),
    },
  };
});

const pick = DocumentPicker.getDocumentAsync as jest.Mock;

async function setup() {
  const hook = await renderHook(() => usePortal());
  await waitFor(() => expect(hook.result.current.documentsProtocol?.protocol_id).toBe('p-1'));
  return hook;
}

beforeEach(() => jest.clearAllMocks());

describe('usePortal study documents', () => {
  it('lists documents for the active protocol', async () => {
    await setup();
    await waitFor(() => expect(api.listDocuments).toHaveBeenCalledWith('p-1'));
  });

  it('adds a note and clears the form', async () => {
    const { result } = await setup();
    await act(async () => {
      result.current.setNoteTitle('About');
      result.current.setNoteText('We study BP.');
    });
    await act(async () => result.current.addNote());
    await waitFor(() => expect(api.addNote).toHaveBeenCalledWith('p-1', 'About', 'We study BP.'));
    await waitFor(() => expect(result.current.noteTitle).toBe(''));
  });

  it('refuses an empty note', async () => {
    const { result } = await setup();
    await act(async () => result.current.addNote());
    expect(api.addNote).not.toHaveBeenCalled();
    expect(result.current.documentsError).toMatch(/title and some text/);
  });

  it('uploads a picked PDF as base64', async () => {
    pick.mockResolvedValueOnce({
      canceled: false,
      assets: [{ name: 'manual.pdf', mimeType: 'application/pdf', size: 1000, uri: 'blob:x', base64: 'JVBERi0=', lastModified: 0 }],
    });
    const { result } = await setup();
    await act(async () => result.current.uploadFile());
    await waitFor(() =>
      expect(api.addFile).toHaveBeenCalledWith('p-1', {
        title: 'manual.pdf', filename: 'manual.pdf', mime_type: 'application/pdf', data_base64: 'JVBERi0=',
      }),
    );
  });

  it('rejects unsupported or oversized files with a message', async () => {
    pick.mockResolvedValueOnce({
      canceled: false,
      assets: [{ name: 'notes.docx', mimeType: 'application/msword', size: 10, uri: 'x', base64: 'AA==', lastModified: 0 }],
    });
    const { result } = await setup();
    await act(async () => result.current.uploadFile());
    await waitFor(() => expect(result.current.documentsError).toMatch(/PDF, JPEG, PNG or WebP/));
    pick.mockResolvedValueOnce({
      canceled: false,
      assets: [{ name: 'big.pdf', mimeType: 'application/pdf', size: 30_000_000, uri: 'x', base64: 'AA==', lastModified: 0 }],
    });
    await act(async () => result.current.uploadFile());
    await waitFor(() => expect(result.current.documentsError).toMatch(/larger than 20 MB/));
    expect(api.addFile).not.toHaveBeenCalled();
  });

  it('cancelling the picker does nothing', async () => {
    const { result } = await setup();
    await act(async () => result.current.uploadFile());
    expect(api.addFile).not.toHaveBeenCalled();
    expect(result.current.documentsError).toBeNull();
  });

  it('removes a document', async () => {
    const { result } = await setup();
    await act(async () => result.current.deleteDocument('d-9'));
    await waitFor(() => expect(api.deleteDocument).toHaveBeenCalledWith('p-1', 'd-9'));
  });
});

it('documents follow the active protocol; none when no protocol is active', async () => {
  const { protocol } = jest.requireActual('../testing/fixtures');
  (api.listProtocols as jest.Mock).mockResolvedValue([{ ...protocol, is_active: false }]);
  const hook = await renderHook(() => usePortal());
  await waitFor(() => expect(hook.result.current.protocols).toHaveLength(1));
  expect(hook.result.current.documentsProtocol).toBeNull();
  (api.listProtocols as jest.Mock).mockResolvedValue([protocol]);
});

describe('usePortal Gem inactivity settings', () => {
  it('loads the saved timings in minutes', async () => {
    const { result } = await setup();
    await waitFor(() => expect(result.current.idleMinutes).toBe('1'));
    expect(result.current.purgeMinutes).toBe('10');
  });

  it('saves valid timings as seconds', async () => {
    const { result } = await setup();
    await waitFor(() => expect(result.current.idleMinutes).toBe('1'));
    await act(async () => {
      result.current.setIdleMinutes('0.5');
      result.current.setPurgeMinutes('15');
    });
    await act(async () => result.current.saveSettings());
    expect(api.saveAssistantSettings).toHaveBeenCalledWith({ idle_after_s: 30, purge_after_s: 900 });
    await waitFor(() => expect(result.current.settingsMessage).toMatch(/Saved/));
    expect(result.current.settingsError).toBeNull();
  });

  it.each([
    ['abc', '10', /in minutes/],
    ['0.1', '10', /between 0.25 and 60/],
    ['5', '5', /longer than/],
    ['5', '2000', /at most 24 hours/],
  ])('rejects idle=%s purge=%s', async (idle, purge, message) => {
    const { result } = await setup();
    await waitFor(() => expect(result.current.idleMinutes).toBe('1'));
    await act(async () => {
      result.current.setIdleMinutes(idle);
      result.current.setPurgeMinutes(purge);
    });
    await act(async () => result.current.saveSettings());
    expect(api.saveAssistantSettings).not.toHaveBeenCalled();
    expect(result.current.settingsError).toMatch(message);
  });

  it('converts between minutes and seconds', () => {
    expect(formatMinutes(90)).toBe('1.5');
    expect(parseMinutes('1,5')).toBe(90);
    expect(parseMinutes('')).toBeNull();
    expect(parseMinutes('-1')).toBeNull();
  });
});
