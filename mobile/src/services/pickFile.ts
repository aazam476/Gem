import * as DocumentPicker from 'expo-document-picker';

import type { StudyFileUpload } from '../api/types';
import { DOCUMENT_TYPES, MAX_DOCUMENT_BYTES } from '../config';
import { bytesToBase64 } from '../logic/wav';

export class PickError extends Error {}

function guessMime(name: string): string | undefined {
  const ext = name.toLowerCase().split('.').pop();
  return { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[
    ext ?? ''
  ];
}

/**
 * Let the researcher choose a PDF or image and return it ready for upload, or null if they
 * cancelled. Works in the web portal (browser file dialog) and on native.
 */
export async function pickStudyFile(): Promise<Omit<StudyFileUpload, 'title'> | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: DOCUMENT_TYPES,
    multiple: false,
    copyToCacheDirectory: true,
    base64: true,
  });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  const mime = asset.mimeType || guessMime(asset.name);
  if (!mime || !DOCUMENT_TYPES.includes(mime)) throw new PickError('Choose a PDF, JPEG, PNG or WebP file.');
  if (asset.size !== undefined && asset.size > MAX_DOCUMENT_BYTES) {
    throw new PickError(`That file is larger than ${MAX_DOCUMENT_BYTES / 1_000_000} MB.`);
  }
  let data = asset.base64;
  if (!data && asset.file) data = bytesToBase64(new Uint8Array(await asset.file.arrayBuffer()));
  if (!data && asset.uri.startsWith('data:')) data = asset.uri.slice(asset.uri.indexOf(',') + 1);
  if (!data) throw new PickError('Could not read that file.');
  return { filename: asset.name, mime_type: mime, data_base64: data };
}
