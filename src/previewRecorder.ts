// The persist step of a render: ONE atomic appendPreviews for everything generated (+ display-dim
// backfill when the original never carried dims), then the reconciliation of what the media store
// kept against what was generated. The media store keeps one row per preview identity, so a row
// can be left out because another worker stored the same identity first (covered, not a failure)
// or because the media is gone; a failed write is logged with the uploads no row points at and
// rethrown. It renders nothing and fires no observer: the Processor fires onPreviewGenerated over
// the rows it returns.
import type { Catalog } from './catalog.ts';
import type { MediaStore } from './contracts/media.ts';
import { ResizeSetupError } from './errors.ts';
import type { Preview, PreviewScope, ResizeLogger } from './types.d.ts';

/** Uploaded locators for a log line; an opaque ref that JSON cannot encode is still named. */
function describeRefs(previews: Preview[]): string {
  return previews
    .map((preview) => {
      try {
        return JSON.stringify(preview.storageRef) ?? String(preview.storageRef);
      } catch {
        return String(preview.storageRef);
      }
    })
    .join(', ');
}

export interface PreviewRecorderDeps {
  catalog: Catalog;
  media: MediaStore;
  logger: ResizeLogger;
}

export interface RecordResult {
  // The generated previews whose identity the media store kept (the generated objects, not the
  // rows the store resolved with, which may be driver documents).
  stored: Preview[];
  // Identities the media store already held from another worker: covered, not failed.
  alreadyStored: string[];
}

/** Records the generated previews of one media in one media store write. */
export class PreviewRecorder {
  readonly #deps: PreviewRecorderDeps;

  constructor(deps: PreviewRecorderDeps) {
    this.#deps = deps;
  }

  /**
   * Append `previews` (all of `scope`) to the media in one write, with `backfillDims` when the
   * original never carried dims, and resolve with the ones the store kept. A failed write is
   * logged and rethrown.
   */
  async record(
    mediaId: string,
    scope: PreviewScope,
    previews: Preview[],
    backfillDims?: { width: number; height: number },
  ): Promise<RecordResult> {
    const { catalog, logger, media: mediaStore } = this.#deps;
    let generated = previews;
    const alreadyStored: string[] = [];
    // The identity of a generated row (every one belongs to `scope`).
    const scopedIdentity = (p: Preview): string => catalog.identity(scope, p);

    // What the media store holds now, read once after a failed or partial write: the identities
    // stored on the media, null when the media is gone, undefined when the reload failed too.
    const recordedIdentities = async (): Promise<
      Set<string> | null | undefined
    > => {
      try {
        const reloaded = await mediaStore.loadMedia(mediaId);
        return reloaded ? catalog.storedIdentities(reloaded, scope) : null;
      } catch {
        return undefined;
      }
    };
    const stored = await mediaStore
      .appendPreviews(mediaId, generated, backfillDims)
      .catch(async (err: unknown) => {
        // The write may have stopped part-way (a driver can store one row at a time). Name
        // only the uploads no row points at, so an operator can find (or delete) them; a file
        // a stored row references is never offered.
        const recorded = await recordedIdentities();
        const unrecorded = recorded
          ? generated.filter((p) => !recorded.has(scopedIdentity(p)))
          : generated;
        logger.error(
          `resize: recording previews failed for media ${mediaId}; ${unrecorded.length} of ${generated.length} uploaded preview(s) are not recorded${recorded === undefined ? ' (the media could not be reloaded to check)' : ''}: storage refs ${describeRefs(unrecorded)}`,
          err,
        );
        throw err;
      });
    // A store written to the old contract resolves with nothing. Read as the rows it stored,
    // that would mean every preview was left out (reported as another worker's,
    // `created: []`), so fail loudly instead, before any observer runs.
    if (!Array.isArray(stored)) {
      throw new ResizeSetupError(
        `resize: MediaStore.appendPreviews must resolve with the previews it stored ([] when none were); for media ${mediaId} it resolved with ${String(stored)}`,
        { code: 'RESIZE_MEDIA_APPEND_RESULT_INVALID' },
      );
    }
    // The media store keeps one row per identity and resolves with the rows it stored. The
    // reload says why a row was left out: the media is gone, or another worker stored the same
    // identity first (covered, not a failure).
    const kept = catalog.storedIdentities({ previews: stored }, scope);
    const leftOut = generated.filter((p) => !kept.has(scopedIdentity(p)));
    if (leftOut.length > 0) {
      generated = generated.filter((p) => kept.has(scopedIdentity(p)));
      const recorded = await recordedIdentities();
      if (recorded === null) {
        logger.warn(
          `resize: media ${mediaId} no longer exists; ${leftOut.length} uploaded preview(s) are not recorded: storage refs ${describeRefs(leftOut)}`,
        );
      } else {
        // A failed reload trusts the store's answer: the rows are another worker's.
        const duplicates = recorded
          ? leftOut.filter((p) => recorded.has(scopedIdentity(p)))
          : leftOut;
        const lost = recorded
          ? leftOut.filter((p) => !recorded.has(scopedIdentity(p)))
          : [];
        if (duplicates.length > 0) {
          logger.warn(
            `resize: ${duplicates.length} preview(s) for media ${mediaId} were already stored by another worker; uploaded but not recorded storage refs: ${describeRefs(duplicates)}`,
          );
          alreadyStored.push(...duplicates.map(scopedIdentity));
        }
        if (lost.length > 0) {
          logger.error(
            `resize: the media store left out ${lost.length} preview(s) for media ${mediaId} that it does not hold; uploaded but not recorded storage refs: ${describeRefs(lost)}`,
          );
        }
      }
    }
    return { stored: generated, alreadyStored };
  }
}
