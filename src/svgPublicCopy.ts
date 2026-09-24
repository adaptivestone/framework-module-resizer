import { getApp } from './app.ts';
import { ResizeMediaError, ResizeStorageError } from './errors.ts';
import type { Resizer } from './resizer.ts';
import type { MediaLike, Original, StorageRef } from './types.d.ts';

export function isSvgOriginal(original: Original | undefined): boolean {
  return (
    original?.contentType === 'image/svg+xml' || original?.format === 'svg'
  );
}

export function isPubliclyServeable(
  resizer: Resizer,
  ref: StorageRef | undefined,
): boolean {
  if (!ref?.key) {
    return false;
  }
  try {
    return resizer.storage.canServeOriginalPublicly?.(ref) === true;
  } catch (error) {
    getApp().logger.error(
      'resize SVG publication: visibility check failed',
      error,
    );
    return false;
  }
}

/** Ensure that an SVG has one public pass-through copy while retaining its private original. */
export async function ensureSvgPublicCopy(
  resizer: Resizer,
  media: MediaLike,
  mediaId: string,
  persist: boolean,
): Promise<StorageRef> {
  const original = media.original;
  if (!original?.key || !isSvgOriginal(original)) {
    throw new ResizeMediaError(
      `resize SVG publication: media ${mediaId} has no SVG original`,
      { mediaId, code: 'RESIZE_SVG_ORIGINAL_MISSING' },
    );
  }
  if (isPubliclyServeable(resizer, original.publicCopy)) {
    return original.publicCopy as StorageRef;
  }
  if (isPubliclyServeable(resizer, original)) {
    return original;
  }

  let publicCopy: StorageRef;
  try {
    publicCopy = resizer.storage.copyToPublic
      ? await resizer.storage.copyToPublic({
          source: original,
          key: original.key,
          contentType: 'image/svg+xml',
        })
      : await resizer.storage.upload({
          key: original.key,
          body: await resizer.storage.download(original),
          contentType: 'image/svg+xml',
          visibility: 'public',
        });
  } catch (cause) {
    throw new ResizeStorageError(
      `resize SVG publication: failed to copy media ${mediaId} into public storage`,
      { code: 'RESIZE_SVG_PUBLIC_COPY_FAILED', cause },
    );
  }
  if (!isPubliclyServeable(resizer, publicCopy)) {
    throw new ResizeStorageError(
      `resize SVG publication: storage did not return a proven-public copy for media ${mediaId}`,
      { code: 'RESIZE_SVG_PUBLIC_COPY_INVALID' },
    );
  }

  if (persist) {
    const saved = await resizer.mediaStore.setOriginalPublicCopy(
      mediaId,
      original.key,
      publicCopy,
    );
    if (!saved) {
      throw new ResizeMediaError(
        `resize SVG publication: media ${mediaId} changed before its public copy was saved`,
        { mediaId, code: 'RESIZE_SVG_ORIGINAL_CHANGED' },
      );
    }
  }
  original.publicCopy = publicCopy;
  return publicCopy;
}
