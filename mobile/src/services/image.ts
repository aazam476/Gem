import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { UPLOAD_JPEG_QUALITY, UPLOAD_LONG_EDGE_PX } from '../config';

export interface PreparedUpload {
  base64: string;
  uri: string;
  width: number;
  height: number;
}

/**
 * Downscale by the long edge (aspect ratio preserved, so text is not distorted and
 * Gemini's normalized box coordinates stay valid) and JPEG-compress before upload.
 */
export async function prepareUpload(
  photo: { uri: string; width: number; height: number },
  options: { longEdge?: number; quality?: number } = {},
): Promise<PreparedUpload> {
  const longEdge = options.longEdge ?? UPLOAD_LONG_EDGE_PX;
  const context = ImageManipulator.manipulate(photo.uri);
  if (Math.max(photo.width, photo.height) > longEdge) {
    context.resize(photo.width >= photo.height ? { width: longEdge } : { height: longEdge });
  }
  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({
    base64: true,
    compress: options.quality ?? UPLOAD_JPEG_QUALITY,
    format: SaveFormat.JPEG,
  });
  if (!result.base64) throw new Error('Image encoder returned no data');
  return { base64: result.base64, uri: result.uri, width: result.width, height: result.height };
}
