import type { AiImage, AiImageMediaType } from './types';

// The user turn's content. Text alone goes out exactly as before — a plain string, so a
// text-only request is byte-for-byte the extension's. With images, each provider's own
// multimodal shape: the images first, then the text (the order Claude recommends, and
// how the prompt reads — the pictures, then the conversation and the question).

/** The image types both providers accept (Claude and DeepSeek alike). */
export const AI_IMAGE_MEDIA_TYPES: readonly AiImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export type ClaudeUserContent =
  | string
  | ({ type: 'image'; source: { type: 'base64'; media_type: AiImageMediaType; data: string } } | { type: 'text'; text: string })[];

export type DeepSeekUserContent =
  | string
  | ({ type: 'image_url'; image_url: { url: string } } | { type: 'text'; text: string })[];

/** The images, checked: a type neither provider takes is a bug upstream, not a request to send. */
function checkedImages(images: AiImage[] | undefined): AiImage[] {
  const list = Array.isArray(images) ? images : [];
  for (const img of list) {
    if (!AI_IMAGE_MEDIA_TYPES.includes(img?.mediaType) || typeof img.data !== 'string' || !img.data) {
      throw new Error('Unsupported image: only JPEG, PNG, GIF and WebP can be sent.');
    }
  }
  return list;
}

/** Claude Messages API: base64 `image` blocks, then a `text` block. */
export function claudeUserContent(text: string, images?: AiImage[]): ClaudeUserContent {
  const list = checkedImages(images);
  if (!list.length) return text;
  return [
    ...list.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.data } })),
    ...(text ? [{ type: 'text' as const, text }] : []),
  ];
}

/** DeepSeek chat/completions (OpenAI-style): `image_url` parts holding data URLs, then a `text` part. */
export function deepSeekUserContent(text: string, images?: AiImage[]): DeepSeekUserContent {
  const list = checkedImages(images);
  if (!list.length) return text;
  return [
    ...list.map((img) => ({ type: 'image_url' as const, image_url: { url: 'data:' + img.mediaType + ';base64,' + img.data } })),
    ...(text ? [{ type: 'text' as const, text }] : []),
  ];
}
