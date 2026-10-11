import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { UPLOAD_JPEG_QUALITY, UPLOAD_LONG_EDGE_PX } from '../config';

export interface PreparedUpload {
  base64: string;
  uri: string;
  width: number;
  height: number;
}

/**
 * Downscale by the long edge (aspect ratio preserved, so digits are not distorted and
 * Gemini's normalized box coordinates stay valid) and JPEG-compress before upload.
 */
export async function prepareUpload(photo: { uri: string; width: number; height: number }): Promise<PreparedUpload> {
  const context = ImageManipulator.manipulate(photo.uri);
  if (Math.max(photo.width, photo.height) > UPLOAD_LONG_EDGE_PX) {
    context.resize(photo.width >= photo.height ? { width: UPLOAD_LONG_EDGE_PX } : { height: UPLOAD_LONG_EDGE_PX });
  }
  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({ base64: true, compress: UPLOAD_JPEG_QUALITY, format: SaveFormat.JPEG });
  if (!result.base64) throw new Error('Image encoder returned no data');
  return { base64: result.base64, uri: result.uri, width: result.width, height: result.height };
}
