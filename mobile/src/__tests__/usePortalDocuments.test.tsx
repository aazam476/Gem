import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';

import { api } from '../api/client';
import { usePortal } from '../hooks/usePortal';
import { protocol } from '../testing/fixtures';

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
