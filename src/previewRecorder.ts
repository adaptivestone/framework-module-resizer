// The persist step of a render: one appendPreviews for the new previews (+ display-dim backfill
// when the original never carried dims), then ONE replacePreviews for the previews that replace
// stored rows of the same identity, then the reconciliation of what the media store kept against
// what was generated. The media store keeps one row per preview identity, so an appended row can
// be left out because another worker stored the same identity first, or because the media is
// gone. A row left out for a fresh row of another worker is covered; one left out for a row with
// other signatures is blocked, so the variant is not covered and its task retries (the retry
// replaces that row). A failed write is logged with the uploads no row points at and rethrown. It
// renders nothing and fires no observer: the Processor fires onPreviewGenerated over the rows it
// returns.
import type { Catalog } from './catalog.ts';
import type { MediaStore, ReplacedPreviews } from './contracts/media.ts';
import { ResizeSetupError } from './errors.ts';
import type {
  MediaLike,
  Preview,
  PreviewScope,
  ResizeLogger,
} from './types.d.ts';

/** One uploaded locator for a log line; an opaque ref that JSON cannot encode is still named. */
function describeRef(preview: Preview): string {
  try {
    return JSON.stringify(preview.storageRef) ?? String(preview.storageRef);
  } catch {
    return String(preview.storageRef);
  }
}

/** Uploaded locators for a log line. */
function describeRefs(previews: Preview[]): string {
  return previews.map(describeRef).join(', ');
}

/**
 * A media store written before replacePreviews existed cannot remove rows. A replacing persist,
 * invalidate() and the Resizer's verify() check it, with one message.
 */
export function requireReplacePreviews(media: MediaStore): void {
  if (typeof media.replacePreviews !== 'function') {
    throw new ResizeSetupError(
      'resize: the media store has no replacePreviews(mediaId, identities, rows) — a custom MediaStore needs it since 0.3.0',
      { code: 'RESIZE_MEDIA_REPLACE_MISSING' },
    );
  }
}

/** A replacePreviews result the core can read (an object with the two lists of rows), or throw. */
export function checkReplaced(result: unknown): ReplacedPreviews {
  if (typeof result === 'object' && result !== null) {
    const { stored, removed } = result as Partial<ReplacedPreviews>;
    if (Array.isArray(stored) && Array.isArray(removed)) {
      return { stored, removed };
    }
  }
  throw new ResizeSetupError(
    "resize: the media store's replacePreviews resolved with something other than { stored, removed } — resolve with the rows it stored and removed ([] when none)",
    { code: 'RESIZE_MEDIA_REPLACE_RESULT_INVALID' },
  );
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
  // Identities the media store already held from another worker in a fresh row: covered, not
  // failed.
  alreadyStored: string[];
  // Identities left out because the media store holds them in a row with other signatures: not
  // covered, so the task fails and its retry replaces that row.
  blocked: string[];
  // The stored rows the replacement removed (their files are not deleted).
  removed: Preview[];
}

/** Records the generated previews of one media in at most one append and one replace. */
export class PreviewRecorder {
  readonly #deps: PreviewRecorderDeps;

  constructor(deps: PreviewRecorderDeps) {
    this.#deps = deps;
  }

  /**
   * Append the `previews` (all of `scope`) whose identity is not in `replacing` in one write, with
   * `backfillDims` when the original never carried dims (an append of no rows when there are only
   * dims to record), then replace the stored rows of the identities in `replacing` with the rest
   * in one write, and resolve with what the store kept. `originDims` is the size the previews were
   * signed with (default: the stored dimensions), so a row another worker stored can be told fresh
   * or stale. A failed write is logged and rethrown.
   */
  async record(
    mediaId: string,
    scope: PreviewScope,
    previews: Preview[],
    backfillDims?: { width: number; height: number },
    replacing?: ReadonlySet<string>,
    originDims?: { width: number; height: number },
  ): Promise<RecordResult> {
    const { catalog } = this.#deps;
    const scopedIdentity = (p: Preview): string => catalog.identity(scope, p);
    const replacements = replacing?.size
      ? previews.filter((p) => replacing.has(scopedIdentity(p)))
      : [];
    const appends =
      replacements.length > 0
        ? previews.filter((p) => !replacing?.has(scopedIdentity(p)))
        : previews;
    // A store that cannot replace fails before any write.
    if (replacements.length > 0) {
      requireReplacePreviews(this.#deps.media);
    }
    const appended =
      appends.length > 0 || backfillDims
        ? await this.#append(
            mediaId,
            scope,
            appends,
            replacements,
            backfillDims,
            originDims,
          )
        : { stored: [], alreadyStored: [], blocked: [] };
    const replaced =
      replacements.length > 0
        ? await this.#replace(mediaId, scope, replacements)
        : { stored: [], removed: [] };
    const kept = new Set([...appended.stored, ...replaced.stored]);
    return {
      // In the order given, whichever write stored them.
      stored: previews.filter((p) => kept.has(p)),
      alreadyStored: appended.alreadyStored,
      blocked: appended.blocked,
      removed: replaced.removed,
    };
  }

  /**
   * What the media store holds now, read once after a failed or partial write: the media, null
   * when it is gone, undefined when the reload failed too.
   */
  async #reload(mediaId: string): Promise<MediaLike | null | undefined> {
    try {
      return await this.#deps.media.loadMedia(mediaId);
    } catch {
      return undefined;
    }
  }

  /** The append write and its reconciliation; `pending` are the replacements still to write. */
  async #append(
    mediaId: string,
    scope: PreviewScope,
    appends: Preview[],
    pending: Preview[],
    backfillDims: { width: number; height: number } | undefined,
    originDims: { width: number; height: number } | undefined,
  ): Promise<Omit<RecordResult, 'removed'>> {
    const { catalog, logger, media: mediaStore } = this.#deps;
    const scopedIdentity = (p: Preview): string => catalog.identity(scope, p);
    const alreadyStored: string[] = [];
    const blocked: string[] = [];
    const stored = await mediaStore
      .appendPreviews(mediaId, appends, backfillDims)
      .catch(async (err: unknown) => {
        // The write may have stopped part-way (a driver can store one row at a time). Name
        // only the uploads no row points at, so an operator can find (or delete) them; a file
        // a stored row references is never offered. The replacements were never written.
        const reloaded = await this.#reload(mediaId);
        const recorded = reloaded
          ? catalog.storedIdentities(reloaded, scope)
          : reloaded;
        const unrecorded = [
          ...(recorded
            ? appends.filter((p) => !recorded.has(scopedIdentity(p)))
            : appends),
          ...pending,
        ];
        const total = appends.length + pending.length;
        logger.error(
          `resize: recording previews failed for media ${mediaId}; ${unrecorded.length} of ${total} uploaded preview(s) are not recorded${recorded === undefined ? ' (the media could not be reloaded to check)' : ''}: storage refs ${describeRefs(unrecorded)}`,
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
    // identity first, in a fresh row (covered) or a row with other signatures (blocked).
    const kept = catalog.storedIdentities({ previews: stored }, scope);
    const leftOut = appends.filter((p) => !kept.has(scopedIdentity(p)));
    if (leftOut.length > 0) {
      const reloaded = await this.#reload(mediaId);
      if (reloaded === null) {
        logger.warn(
          `resize: media ${mediaId} no longer exists; ${leftOut.length} uploaded preview(s) are not recorded: storage refs ${describeRefs(leftOut)}`,
        );
      } else {
        // A failed reload trusts the store's answer: the rows are another worker's.
        const recorded = reloaded && catalog.storedIdentities(reloaded, scope);
        const fresh =
          reloaded && catalog.freshIdentities(reloaded, scope, originDims);
        const duplicates = leftOut.filter(
          (p) => !fresh || fresh.has(scopedIdentity(p)),
        );
        const others = leftOut.filter(
          (p) =>
            fresh &&
            !fresh.has(scopedIdentity(p)) &&
            recorded?.has(scopedIdentity(p)),
        );
        const lost = leftOut.filter(
          (p) => recorded && !recorded.has(scopedIdentity(p)),
        );
        if (duplicates.length > 0) {
          logger.warn(
            `resize: ${duplicates.length} preview(s) for media ${mediaId} were already stored by another worker; uploaded but not recorded storage refs: ${describeRefs(duplicates)}`,
          );
          alreadyStored.push(...duplicates.map(scopedIdentity));
        }
        if (others.length > 0) {
          logger.warn(
            `resize: ${others.length} preview(s) for media ${mediaId} were not recorded because another worker stored their identity with other settings or from another original, so they are not covered and a retry replaces that row; uploaded but not recorded storage refs: ${describeRefs(others)}`,
          );
          blocked.push(...others.map(scopedIdentity));
        }
        if (lost.length > 0) {
          logger.error(
            `resize: the media store left out ${lost.length} preview(s) for media ${mediaId} that it does not hold; uploaded but not recorded storage refs: ${describeRefs(lost)}`,
          );
        }
      }
    }
    return {
      stored: appends.filter((p) => kept.has(scopedIdentity(p))),
      alreadyStored,
      blocked,
    };
  }

  /** The one replace write of `rows` and its reconciliation. */
  async #replace(
    mediaId: string,
    scope: PreviewScope,
    rows: Preview[],
  ): Promise<{ stored: Preview[]; removed: Preview[] }> {
    const { catalog, logger, media: mediaStore } = this.#deps;
    const scopedIdentity = (p: Preview): string => catalog.identity(scope, p);
    let result: ReplacedPreviews;
    try {
      result = checkReplaced(
        await mediaStore.replacePreviews(mediaId, [], rows),
      );
    } catch (err) {
      // The old row of each identity may still be there, so a reload by identity cannot tell:
      // name the uploads no stored row points at.
      const reloaded = await this.#reload(mediaId);
      const refs = new Set((reloaded?.previews ?? []).map(describeRef));
      const unrecorded = rows.filter((p) => !refs.has(describeRef(p)));
      logger.error(
        `resize: replacing previews failed for media ${mediaId}; ${unrecorded.length} of ${rows.length} uploaded preview(s) are not recorded${reloaded === undefined ? ' (the media could not be reloaded to check)' : ''}: storage refs ${describeRefs(unrecorded)}`,
        err,
      );
      throw err;
    }
    const { removed } = result;
    if (result.stored.length === 0 && removed.length === 0) {
      logger.warn(
        `resize: media ${mediaId} no longer exists; ${rows.length} uploaded preview(s) are not recorded: storage refs ${describeRefs(rows)}`,
      );
      return { stored: [], removed: [] };
    }
    const kept = catalog.storedIdentities({ previews: result.stored }, scope);
    const lost = rows.filter((p) => !kept.has(scopedIdentity(p)));
    if (lost.length > 0) {
      logger.error(
        `resize: the media store left out ${lost.length} preview(s) for media ${mediaId} that it does not hold; uploaded but not recorded storage refs: ${describeRefs(lost)}`,
      );
    }
    if (removed.length > 0) {
      logger.info(
        `resize: replaced ${removed.length} outdated preview(s) of media ${mediaId}; their files are not deleted: storage refs ${describeRefs(removed)}`,
      );
    }
    return {
      stored: rows.filter((p) => kept.has(scopedIdentity(p))),
      removed,
    };
  }
}
