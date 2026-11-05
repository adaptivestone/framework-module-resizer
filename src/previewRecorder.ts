// The persist step of a render: one appendPreviews for the new previews (+ display-dim backfill
// when the original never carried dims), then ONE replacePreviews for the previews that replace
// stored rows of the same identity, then the reconciliation of what the media store kept against
// what was generated. The media store keeps one row per preview identity, so an appended row can
// be left out because another worker stored the same identity first, or because the media is
// gone. A row left out for a fresh row of another worker is covered; one left out for a row with
// other signatures is blocked, so the variant is not covered and its task retries (the retry
// replaces that row). A failed write is logged with the uploads no row points at and returned as
// the result's `failure`, beside what the store kept before it failed (an earlier write of the
// same persist, or the part a failed append stored), so the caller can tell which variants were
// stored before it rethrows. It renders nothing and fires no observer: the Processor fires
// onPreviewGenerated over the rows it returns. rowsNotKept() and rowsWithoutIdentity() are the
// worker's later check that the rows a reload holds under each written storageRef are the rows that
// were written.
import type { Catalog } from './catalog.ts';
import type { MediaStore, ReplacedPreviews } from './contracts/media.ts';
import { ResizeSetupError } from './errors.ts';
import { logNeverThrow } from './helpers/log.ts';
import { getFilterSig, previewScope } from './images.ts';
import type {
  MediaLike,
  Preview,
  PreviewScope,
  ResizeLogger,
} from './types.d.ts';

/**
 * One uploaded locator for a log line; an opaque ref that JSON cannot encode is still named. A ref
 * is host data: when it cannot be printed either, the line must still be written.
 */
function describeRef(preview: Preview): string {
  try {
    return JSON.stringify(preview.storageRef) ?? String(preview.storageRef);
  } catch {
    try {
      return String(preview.storageRef);
    } catch {
      return '(a storage ref that cannot be printed)';
    }
  }
}

/** Uploaded locators for a log line. */
function describeRefs(previews: Preview[]): string {
  return previews.map(describeRef).join(', ');
}

/** A row's filter signature; filters it cannot read are their own value. */
function filterSig(row: Preview): string {
  try {
    return getFilterSig(row.filters);
  } catch {
    return 'unreadable';
  }
}

// What a store must read back as written, compared as they are. `fit` is left out on purpose: a
// store may not keep it, and freshness then accepts either signature. So is `identity`: a read
// never uses it, so a store keyed by the identity it computes works without it, and that row only
// gets a warning (rowsWithoutIdentity).
const KEPT_FIELDS = ['origin', 'encodeSig', 'sizeKey', 'format'] as const;

export type KeptField =
  | (typeof KEPT_FIELDS)[number]
  | 'contentType'
  | 'resizer'
  | 'pipeline'
  | 'filters'
  | 'storageRef';

// What a read finds a row by, so the fields that tell one size key's row from another's.
const READ_FIELDS: ReadonlySet<KeptField> = new Set([
  'sizeKey',
  'format',
  'resizer',
  'pipeline',
  'filters',
]);

/** A written row a reload holds in another form, and the fields of the closest row there. */
export interface RowNotKept {
  identity: string;
  fields: KeptField[];
}

/**
 * The fields `held` differs from `row` in, or undefined when a row cannot be read: rows and refs
 * are host data, and a getter can throw. Such a row says nothing about a write.
 */
function differences(held: Preview, row: Preview): KeptField[] | undefined {
  try {
    const fields: KeptField[] = KEPT_FIELDS.filter(
      (field) => held[field] !== row[field],
    );
    // A read cannot serve a row without one, but takes any: a store's own form of it still works.
    if (!held.contentType) {
      fields.push('contentType');
    }
    // A read finds a row by these too, with their defaults: a store that loses one makes that read
    // miss the row.
    const [own, wrote] = [previewScope(held), previewScope(row)];
    if (own.resizer !== wrote.resizer) {
      fields.push('resizer');
    }
    if (own.pipeline !== wrote.pipeline) {
      fields.push('pipeline');
    }
    if (filterSig(held) !== filterSig(row)) {
      fields.push('filters');
    }
    return fields;
  } catch {
    return undefined;
  }
}

const readMisses = (fields: KeptField[]): number =>
  fields.filter((field) => READ_FIELDS.has(field)).length;

/**
 * Which ref group a row belongs to: its ref as JSON, `null` when it holds no ref, undefined when it
 * cannot be told apart from another (a ref JSON cannot encode, or a row that cannot be read).
 */
function refGroup(row: Preview): string | null | undefined {
  try {
    return row.storageRef == null ? null : JSON.stringify(row.storageRef);
  } catch {
    return undefined;
  }
}

/** A written row beside what a reload holds for it. */
interface WrittenRow {
  row: Preview;
  // The rows under its storageRef that can be read, each with the fields it differs in.
  under: { held: Preview; fields: KeptField[] }[];
  // Nothing is under its ref, and a row a read would take for it came back without a ref.
  lostRef: boolean;
}

/** The written rows that can be judged. With nothing written, no row read back is touched. */
function compareWritten(
  written: readonly Preview[],
  readBack: readonly Preview[] | null | undefined,
): WrittenRow[] {
  if (written.length === 0) {
    return [];
  }
  const groups = new Map<string | null, Preview[]>();
  for (const held of readBack ?? []) {
    const key = refGroup(held);
    if (key !== undefined) {
      groups.set(key, [...(groups.get(key) ?? []), held]);
    }
  }
  return written.flatMap((row) => {
    const key = refGroup(row);
    if (key == null) {
      return [];
    }
    const under = (groups.get(key) ?? []).flatMap((held) => {
      const fields = differences(held, row);
      return fields ? [{ held, fields }] : [];
    });
    const lostRef =
      !groups.has(key) &&
      (groups.get(null) ?? []).some((held) => {
        const fields = differences(held, row);
        return fields !== undefined && readMisses(fields) === 0;
      });
    return [{ row, under, lostRef }];
  });
}

/**
 * The `written` rows the store did not keep as written, judged by the rows `readBack` holds under
 * each one's storageRef. No row under a ref says nothing: the reload may lag, and a store that
 * reshapes its refs is not detected. A row a read would take for this one, with no ref at all, says
 * the store lost the ref. A row or a ref that cannot be read is skipped. A content-addressed store
 * can return one ref for two rows with equal bytes, so a written row is kept when any row of its
 * group matches it; when none does, the fields named are those of the group's closest row: the
 * fewest differences in what a read finds a row by (another size key's row can differ in one field
 * too), then the fewest differences, the first on a tie, since a list of "fields no row holds" can
 * come out empty.
 */
export function rowsNotKept(
  written: readonly Preview[],
  readBack: readonly Preview[] | null | undefined,
): RowNotKept[] {
  const notKept: RowNotKept[] = [];
  for (const { row, under, lostRef } of compareWritten(written, readBack)) {
    let closest: KeptField[] | undefined = lostRef ? ['storageRef'] : undefined;
    for (const { fields } of under) {
      const closer =
        !closest ||
        (readMisses(fields) - readMisses(closest) ||
          fields.length - closest.length) < 0;
      if (closer) {
        closest = fields;
      }
    }
    // No group: nothing to judge. An empty list: some row of the group matches.
    if (closest && closest.length > 0) {
      notKept.push({ identity: String(row.identity), fields: closest });
    }
  }
  return notKept;
}

/**
 * The identities of the `written` rows the store kept with another `identity`, or with none. Such a
 * row is served, but invalidate() and replacePreviews find rows only by identity. An identity that
 * cannot be read says nothing.
 */
export function rowsWithoutIdentity(
  written: readonly Preview[],
  readBack: readonly Preview[] | null | undefined,
): string[] {
  const holdsIdentity = (held: Preview, row: Preview): boolean => {
    try {
      return held.identity === row.identity;
    } catch {
      return true;
    }
  };
  return compareWritten(written, readBack).flatMap(({ row, under }) => {
    const kept = under.filter(({ fields }) => fields.length === 0);
    return kept.length > 0 && !kept.some(({ held }) => holdsIdentity(held, row))
      ? [String(row.identity)]
      : [];
  });
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

/** What record() writes besides the previews. */
export interface RecordOptions {
  // The original's dimensions, recorded by the append (one of no rows when nothing else is).
  backfillDims?: { width: number; height: number };
  // Identities whose stored rows the previews of that identity replace, in one replace write.
  replacing?: ReadonlySet<string>;
  // The size the previews were signed with (default: the stored dimensions), so a row another
  // worker stored can be told fresh or stale.
  originDims?: { width: number; height: number };
}

export interface RecordResult {
  // The generated previews whose identity the media store kept (the generated objects, not the
  // rows the store resolved with, which may be driver documents), in the order given.
  stored: Preview[];
  // Identities the media store already held from another worker in a fresh row: covered, not
  // failed.
  alreadyStored: string[];
  // Identities left out because the media store holds them in a row with other signatures: not
  // covered, so the task fails and its retry replaces that row.
  blocked: string[];
  // The stored rows the replacement removed (their files are not deleted).
  removed: Preview[];
  // Set when the persist failed: the caller rethrows `error`. A write the store rejected is
  // already logged here; an append result that is not an array (RESIZE_MEDIA_APPEND_RESULT_INVALID)
  // and a store without replacePreviews are not, and reach the caller through `error` alone.
  // `stored` then holds only what the store kept before the failure: the append before a failed
  // replace, or the rows a failed append stored part-way (by the reloaded media).
  failure?: { error: unknown };
}

/** Records the generated previews of one media in at most one append and one replace. */
export class PreviewRecorder {
  readonly #deps: PreviewRecorderDeps;

  constructor(deps: PreviewRecorderDeps) {
    this.#deps = deps;
  }

  /**
   * Append the `previews` (all of `scope`) whose identity is not in `opts.replacing` in one write,
   * with `opts.backfillDims` when the original never carried dims (an append of no rows when there
   * are only dims to record), then replace the stored rows of the identities in `opts.replacing`
   * with the rest in one write, and resolve with what the store kept. It never rejects: a failed
   * write is logged and returned as `failure`, for the caller to rethrow.
   */
  async record(
    mediaId: string,
    scope: PreviewScope,
    previews: Preview[],
    opts: RecordOptions = {},
  ): Promise<RecordResult> {
    const { backfillDims, replacing, originDims } = opts;
    const isReplacement = (p: Preview): boolean =>
      replacing?.has(this.#identity(scope, p)) === true;
    const replacements = replacing?.size ? previews.filter(isReplacement) : [];
    const appends =
      replacements.length > 0
        ? previews.filter((p) => !isReplacement(p))
        : previews;
    const result: RecordResult = {
      stored: [],
      alreadyStored: [],
      blocked: [],
      removed: [],
    };
    const kept = new Set<Preview>();
    // In the order given, whichever write stored them.
    const settle = (): RecordResult => ({
      ...result,
      stored: previews.filter((p) => kept.has(p)),
    });
    try {
      // A store that cannot replace fails before any write.
      if (replacements.length > 0) {
        requireReplacePreviews(this.#deps.media);
      }
      if (appends.length > 0 || backfillDims) {
        const appended = await this.#append(mediaId, scope, appends, {
          pending: replacements,
          backfillDims,
          originDims,
          kept,
        });
        for (const p of appended.stored) {
          kept.add(p);
        }
        result.alreadyStored = appended.alreadyStored;
        result.blocked = appended.blocked;
      }
      if (replacements.length > 0) {
        const replaced = await this.#replace(mediaId, scope, replacements);
        for (const p of replaced.stored) {
          kept.add(p);
        }
        result.removed = replaced.removed;
      }
    } catch (error) {
      result.failure = { error };
    }
    return settle();
  }

  /** The identity of a generated preview (every one belongs to `scope`). */
  #identity(scope: PreviewScope, preview: Preview): string {
    return this.#deps.catalog.identity(scope, preview);
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

  /** Uploads not recorded because the media is gone. */
  #warnGone(mediaId: string, rows: Preview[]): void {
    this.#deps.logger.warn(
      `resize: media ${mediaId} no longer exists; ${rows.length} uploaded preview(s) are not recorded: storage refs ${describeRefs(rows)}`,
    );
  }

  /** Uploads the store left out although it does not hold their identity. */
  #errorLost(mediaId: string, rows: Preview[]): void {
    this.#deps.logger.error(
      `resize: the media store left out ${rows.length} preview(s) for media ${mediaId} that it does not hold; uploaded but not recorded storage refs: ${describeRefs(rows)}`,
    );
  }

  /**
   * The append write and its reconciliation; `pending` are the replacements still to write. When
   * the write fails part-way, the appends whose identity the reloaded media holds go to `kept`
   * before it rethrows: the store did keep them.
   */
  async #append(
    mediaId: string,
    scope: PreviewScope,
    appends: Preview[],
    opts: {
      pending: Preview[];
      backfillDims: { width: number; height: number } | undefined;
      originDims: { width: number; height: number } | undefined;
      kept: Set<Preview>;
    },
  ): Promise<Pick<RecordResult, 'stored' | 'alreadyStored' | 'blocked'>> {
    const { catalog, logger, media: mediaStore } = this.#deps;
    const { pending, backfillDims, originDims } = opts;
    const identity = (p: Preview): string => this.#identity(scope, p);
    const alreadyStored: string[] = [];
    const blocked: string[] = [];
    const stored = await mediaStore
      .appendPreviews(mediaId, appends, backfillDims)
      .catch(async (err: unknown) => {
        const total = appends.length + pending.length;
        if (total === 0) {
          // Only the dimensions were to be written: no upload is affected.
          logNeverThrow(
            logger,
            `resize: recording the original's dimensions failed for media ${mediaId}${backfillDims ? ` (${backfillDims.width}×${backfillDims.height})` : ''}; no uploaded preview is affected`,
            err,
          );
          throw err;
        }
        // The write may have stopped part-way (a driver can store one row at a time). Name
        // only the uploads no row points at, so an operator can find (or delete) them; a file
        // a stored row references is never offered. The replacements were never written.
        const reloaded = await this.#reload(mediaId);
        const recorded = reloaded
          ? catalog.storedIdentities(reloaded, scope)
          : reloaded;
        if (recorded) {
          for (const p of appends) {
            if (recorded.has(identity(p))) {
              opts.kept.add(p);
            }
          }
        }
        const unrecorded = [
          ...(recorded
            ? appends.filter((p) => !recorded.has(identity(p)))
            : appends),
          ...pending,
        ];
        logNeverThrow(
          logger,
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
    const leftOut = appends.filter((p) => !kept.has(identity(p)));
    if (leftOut.length > 0) {
      const reloaded = await this.#reload(mediaId);
      if (reloaded === null) {
        this.#warnGone(mediaId, leftOut);
      } else {
        // A failed reload trusts the store's answer: the rows are another worker's.
        const recorded = reloaded && catalog.storedIdentities(reloaded, scope);
        const fresh =
          reloaded && catalog.freshIdentities(reloaded, scope, originDims);
        const duplicates = leftOut.filter(
          (p) => !fresh || fresh.has(identity(p)),
        );
        const others = leftOut.filter(
          (p) => fresh && !fresh.has(identity(p)) && recorded?.has(identity(p)),
        );
        const lost = leftOut.filter(
          (p) => recorded && !recorded.has(identity(p)),
        );
        if (duplicates.length > 0) {
          logger.warn(
            `resize: ${duplicates.length} preview(s) for media ${mediaId} were already stored by another worker; uploaded but not recorded storage refs: ${describeRefs(duplicates)}`,
          );
          alreadyStored.push(...duplicates.map(identity));
        }
        if (others.length > 0) {
          logger.warn(
            `resize: ${others.length} preview(s) for media ${mediaId} were not recorded because another worker stored their identity with other settings or from another original, so they are not covered and a retry replaces that row; uploaded but not recorded storage refs: ${describeRefs(others)}`,
          );
          blocked.push(...others.map(identity));
        }
        if (lost.length > 0) {
          this.#errorLost(mediaId, lost);
        }
      }
    }
    return {
      stored: appends.filter((p) => kept.has(identity(p))),
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
    let result: ReplacedPreviews;
    try {
      // The replaced identities are named as well as carried by the rows: a store that removes
      // only the rows of `identities` (all invalidate() ever needed) still removes the old rows.
      result = checkReplaced(
        await mediaStore.replacePreviews(
          mediaId,
          rows.map((row) => this.#identity(scope, row)),
          rows,
        ),
      );
    } catch (err) {
      // The old row of each identity may still be there, so a reload by identity cannot tell:
      // name the uploads no stored row points at.
      const reloaded = await this.#reload(mediaId);
      const refs = new Set((reloaded?.previews ?? []).map(describeRef));
      const unrecorded = rows.filter((p) => !refs.has(describeRef(p)));
      logNeverThrow(
        logger,
        `resize: replacing previews failed for media ${mediaId}; ${unrecorded.length} of ${rows.length} uploaded preview(s) are not recorded${reloaded === undefined ? ' (the media could not be reloaded to check)' : ''}: storage refs ${describeRefs(unrecorded)}`,
        err,
      );
      throw err;
    }
    const { removed } = result;
    if (result.stored.length === 0 && removed.length === 0) {
      this.#warnGone(mediaId, rows);
      return { stored: [], removed: [] };
    }
    const kept = catalog.storedIdentities({ previews: result.stored }, scope);
    const lost = rows.filter((p) => !kept.has(this.#identity(scope, p)));
    if (lost.length > 0) {
      this.#errorLost(mediaId, lost);
    }
    if (removed.length > 0) {
      // The rows this write removed: the outdated ones, or a row of the same identity another
      // worker stored meanwhile.
      logger.info(
        `resize: replaced ${removed.length} outdated preview(s) of media ${mediaId}; their files are not deleted: storage refs ${describeRefs(removed)}`,
      );
    }
    return {
      stored: rows.filter((p) => kept.has(this.#identity(scope, p))),
      removed,
    };
  }
}
