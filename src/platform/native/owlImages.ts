import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { ImageRef } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';

import type { OwlImage } from '../../core/owl';
import { newOwlImageId, isOwlImageId } from '../../core/owl';
import type { AiImageMediaType } from '../../core/ai';

// Images for the Owl chat, on the phone: pick (photo library or camera), convert, keep,
// read back, tidy up.
//
// Whatever the phone can open — JPEG, PNG, HEIC/HEIF, WebP, GIF, BMP, AVIF… — is
// re-encoded to a type both AI providers read: PNG when the source may have
// transparency (PNG, GIF, WebP), JPEG otherwise. It is also scaled to at most 1568 px
// on the long edge: the most The Owl's Claude model takes in (larger images are scaled
// down on arrival anyway, by DeepSeek too), so nothing is lost and uploads stay small.

/** Longest side, in pixels, of an image sent to The Owl. */
export const OWL_IMAGE_MAX_EDGE = 1568;
const JPEG_QUALITY = 0.85;
/**
 * A PNG bigger than this (base64 characters) goes as JPEG instead — a photo saved as PNG
 * can be several MB, and Claude takes at most 10 MB of base64 per image.
 */
const MAX_PNG_BASE64 = 4_000_000;

/** An image picked for the next question: its record, its bytes, and the converted file. */
export interface PendingOwlImage {
  image: OwlImage;
  /** The converted image, base64 — what is sent. */
  base64: string;
  /** The converted file (in the cache until the question is sent). */
  uri: string;
}

export type OwlImageSource = 'library' | 'camera';

const DIR = FileSystem.documentDirectory ? FileSystem.documentDirectory + 'owl-images/' : null;

const EXTENSION: Record<AiImageMediaType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** Where this phone keeps a chat image (whether or not it has it). Null for an untrusted id. */
export function owlImageUri(image: OwlImage): string | null {
  if (!DIR || !isOwlImageId(image?.id)) return null;
  return DIR + image.id + (EXTENSION[image.mediaType] || '.img');
}

/** May the source have transparency? Then it is kept as PNG (JPEG would turn it black). */
function mayBeTransparent(mimeType: string | null | undefined, fileName: string | null | undefined): boolean {
  return /png|gif|webp/i.test(mimeType || '') || /\.(png|gif|webp)$/i.test(fileName || '');
}

function release(...refs: ({ release(): void } | null | undefined)[]): void {
  for (const ref of refs) {
    try {
      ref?.release();
    } catch {
      /* already released */
    }
  }
}

/** Convert one picked image: decode, scale down to OWL_IMAGE_MAX_EDGE, re-encode. */
async function prepareOwlImage(uri: string, transparent: boolean): Promise<PendingOwlImage> {
  const context = ImageManipulator.manipulate(uri);
  let original: ImageRef | null = null;
  let scaled: ImageRef | null = null;
  try {
    // Render once to learn the real (orientation-corrected) size, then scale if needed.
    original = await context.renderAsync();
    let image: ImageRef = original;
    if (Math.max(original.width, original.height) > OWL_IMAGE_MAX_EDGE) {
      context.resize(original.width >= original.height ? { width: OWL_IMAGE_MAX_EDGE } : { height: OWL_IMAGE_MAX_EDGE });
      scaled = await context.renderAsync();
      image = scaled;
    }
    let mediaType: AiImageMediaType = transparent ? 'image/png' : 'image/jpeg';
    let saved = await image.saveAsync({ format: transparent ? SaveFormat.PNG : SaveFormat.JPEG, compress: JPEG_QUALITY, base64: true });
    if (transparent && (saved.base64?.length ?? 0) > MAX_PNG_BASE64) {
      void FileSystem.deleteAsync(saved.uri, { idempotent: true }).catch(() => undefined);
      saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY, base64: true });
      mediaType = 'image/jpeg';
    }
    if (!saved.base64) throw new Error('The converted image has no data.');
    return {
      image: { id: newOwlImageId(), mediaType, width: saved.width, height: saved.height },
      base64: saved.base64,
      uri: saved.uri,
    };
  } finally {
    release(scaled, original, context);
  }
}

/**
 * Let the user choose images (or take a photo) and convert them for The Owl. Resolves
 * with what could be converted and how many couldn't; nothing when they cancel. Throws,
 * with a message fit to show, when camera access is refused.
 */
export async function pickOwlImages(source: OwlImageSource, limit: number): Promise<{ images: PendingOwlImage[]; failed: number }> {
  if (limit <= 0) return { images: [], failed: 0 };
  let result: ImagePicker.ImagePickerResult;
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      throw new Error('Kano is not allowed to use the camera. You can allow it in your phone’s Settings → Apps → Kano → Permissions.');
    }
    result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
  } else {
    result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: limit > 1,
      selectionLimit: limit,
      orderedSelection: true,
      quality: 1,
    });
  }
  if (result.canceled || !result.assets?.length) return { images: [], failed: 0 };

  const images: PendingOwlImage[] = [];
  let failed = 0;
  for (const asset of result.assets.slice(0, limit)) {
    try {
      images.push(await prepareOwlImage(asset.uri, mayBeTransparent(asset.mimeType, asset.fileName)));
    } catch {
      failed += 1;
    }
  }
  return { images, failed };
}

/** Keep a sent image for good: move it from the cache into the chat's image folder. */
export async function keepOwlImage(pending: PendingOwlImage): Promise<void> {
  const to = owlImageUri(pending.image);
  if (!DIR || !to) return;
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => undefined);
  try {
    await FileSystem.moveAsync({ from: pending.uri, to });
  } catch {
    // The cache copy is gone (the system can clear the cache): write the bytes we hold.
    await FileSystem.writeAsStringAsync(to, pending.base64, { encoding: FileSystem.EncodingType.Base64 });
  }
}

/** Drop a picked image that won't be sent (its converted copy in the cache). */
export function discardOwlImage(pending: PendingOwlImage): void {
  void FileSystem.deleteAsync(pending.uri, { idempotent: true }).catch(() => undefined);
}

/** A kept image's bytes (base64), or null if this phone doesn't have it. */
export async function readOwlImage(image: OwlImage): Promise<string | null> {
  const uri = owlImageUri(image);
  if (!uri) return null;
  try {
    if (!(await FileSystem.getInfoAsync(uri)).exists) return null;
    return await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  } catch {
    return null;
  }
}

/**
 * Delete the image files no message refers to any more (cleared or scrolled out of the
 * chat). `keep` is asked per file, at the moment of deletion, so an image being added
 * meanwhile is never caught by a list taken earlier. Best effort.
 */
export async function pruneOwlImages(keep: (id: string) => boolean): Promise<void> {
  if (!DIR) return;
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(DIR);
  } catch {
    return; // no folder yet: nothing to tidy
  }
  for (const name of names) {
    const id = name.replace(/\.[a-z0-9]+$/i, '');
    if (keep(id)) continue;
    await FileSystem.deleteAsync(DIR + name, { idempotent: true }).catch(() => undefined);
  }
}
