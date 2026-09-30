// The enqueue half of the HTTP-side path (06 · §18). Turns the read's `missing`
// variants into ONE queued task, collapsing a concurrent read fan-out into a single
// dispatch via per-identity dispatch locks. Never throws into the caller's read: on any
// transport failure it logs + releases the survivors' locks so a later read can retry.
// Takes the Resizer type-only (the resizer.ts → engine.ts → enqueue.ts value chain never
// closes back on this module at runtime — 05 · design delta).
import { createHash } from 'node:crypto';
import { getApp } from './app.ts';
import { canonicalizeFilterValue, getPreviewIdentity } from './images.ts';
import { getResizeConfig } from './resizeConfig.ts';
import type { Resizer } from './resizer.ts';
import type {
  EnqueueIssue,
  EnqueueReceipt,
  MissingPreview,
} from './types.d.ts';

function normalizeVariant(variant: MissingPreview): MissingPreview {
  const normalized: MissingPreview = {
    sizeKey: variant.sizeKey,
    format: variant.format,
  };
  if (variant.filters && Object.keys(variant.filters).length > 0) {
    normalized.filters = canonicalizeFilterValue(
      variant.filters,
    ) as MissingPreview['filters'];
  }
  if (variant.requestedWidth !== undefined) {
    normalized.requestedWidth = variant.requestedWidth;
  }
  if (variant.requestedHeight !== undefined) {
    normalized.requestedHeight = variant.requestedHeight;
  }
  if (variant.fit !== undefined) {
    normalized.fit = variant.fit;
  }
  return normalized;
}

/**
 * Canonicalize a complete queue payload: normalize nested filter keys, remove exact
 * duplicate variants, and sort the result by the canonical representation. The
 * stable result is used by Mongo enqueue so list permutation cannot create another
 * durable task.
 */
export function canonicalizeVariants(
  variants: readonly MissingPreview[],
): MissingPreview[] {
  const byKey = new Map<string, MissingPreview>();
  for (const variant of variants) {
    const normalized = normalizeVariant(variant);
    const key = JSON.stringify(normalized);
    if (!byKey.has(key)) {
      byKey.set(key, normalized);
    }
  }
  return (
    [...byKey.entries()]
      // Do not use localeCompare: durable identity ordering must be independent of
      // the host process locale.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, variant]) => variant)
  );
}

/**
 * Build a bounded request identity for the durable Mongo dedupe index. The complete
 * file + pipeline identity is included before hashing; the hash keeps the indexed
 * value small even when filters or the variant catalog are large.
 */
export function buildRequestKey(
  mediaId: string,
  pipeline: string,
  variants: readonly MissingPreview[],
): string {
  const canonical = canonicalizeVariants(variants);
  // FNV-style string hashing would be shorter but collision-prone for a durable
  // correctness key. Web Crypto is not guaranteed in every supported Node runtime,
  // so use the built-in SHA-256 implementation.
  const json = JSON.stringify({
    fileId: mediaId,
    pipeline,
    variants: canonical,
  });
  return `v1:${createHash('sha256').update(json).digest('hex')}`;
}

/**
 * §18. Dedup `missing` by identity, acquire a per-variant dispatch lock, enqueue the
 * lock-winners as one task, and release those locks only on failure (a throw OR a
 * `taskId === null` soft failure). On success the locks are deliberately left to expire
 * — they collapse concurrent read fan-out into this single task.
 *
 * Returns the number of variants HANDED TO the transport — the lock-winners on a successful
 * enqueue (prewarm's `enqueued`, 11 · §11.1b step 4). Every non-success path returns 0: no
 * transport, no surviving lock, a throw, or a `taskId === null` soft failure (the released
 * locks let a later read retry, so nothing durable was queued). resolve() ignores the count.
 */
export async function enqueue(
  resizer: Resizer,
  mediaId: string,
  pipeline: string,
  missing: MissingPreview[],
): Promise<number> {
  // Defensive: resolve guarantees a transport before calling us (§17 step 9), but never
  // assume — bail before grabbing any lock we could not use.
  const { transport } = resizer;
  if (!transport) {
    return 0;
  }

  // 1. Canonicalize first so equivalent nested filter objects and list permutations
  // reach the transport in a stable form. The dispatch lock remains per preview
  // identity (not per whole catalog) by design; durable Mongo dedupe handles the
  // complete request key.
  const canonical = canonicalizeVariants(missing);

  // 2. Dedup by identity — the one lookup/lock key, built one way (03 · Identity).
  const byIdentity = new Map<string, MissingPreview>();
  for (const m of canonical) {
    const identity = getPreviewIdentity(m.sizeKey, m.format, m.filters);
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, m);
    }
  }

  // 3. Acquire the dispatch lock per identity; keep only the winners (others are already
  // in flight from a concurrent read). TTL in ms — the framework driver converts to s.
  const dispatchTtlMs = getResizeConfig().queue.lockTtlMs.dispatch;
  const survivors: MissingPreview[] = [];
  const survivorLockKeys: string[] = [];
  for (const [identity, m] of byIdentity) {
    const lockKey = `resize_dispatch:${mediaId}:${identity}`;
    // A rejecting acquire = this variant is NOT a survivor (log + continue); earlier survivors are
    // unaffected and still reach the transport. enqueue must never throw into the read (1.2b).
    let acquired: boolean;
    try {
      acquired = await resizer.lockProvider.acquire(lockKey, dispatchTtlMs);
    } catch (err) {
      getApp().logger.error(
        `resize enqueue: dispatch-lock acquire failed for ${lockKey} on media ${mediaId} — skipping this variant`,
        err,
      );
      continue;
    }
    if (acquired) {
      survivors.push(m);
      survivorLockKeys.push(lockKey);
    }
  }

  // 4. None survive → nothing to dispatch.
  if (survivors.length === 0) {
    return 0;
  }

  // 5/6. Enqueue; on a throw OR a null taskId (soft failure) log + release the survivors'
  // locks so a later read retries instead of waiting out the TTL. NEVER throw to caller.
  try {
    const { taskId } = await transport.enqueue({
      mediaId,
      pipeline,
      previews: survivors,
    });
    if (taskId === null) {
      getApp().logger.error(
        `resize enqueue: transport returned a null taskId for media ${mediaId} — releasing ${survivorLockKeys.length} dispatch lock(s) so a later read retries`,
      );
      await releaseAll(resizer, survivorLockKeys);
      return 0;
    }
    // A non-null taskId = success: the dispatch locks are intentionally held to their TTL.
    return survivors.length;
  } catch (err) {
    getApp().logger.error(
      `resize enqueue: transport.enqueue threw for media ${mediaId} — releasing ${survivorLockKeys.length} dispatch lock(s) so a later read retries`,
      err,
    );
    await releaseAll(resizer, survivorLockKeys);
    return 0;
  }
}

export interface ConfirmedEnqueueResult {
  accepted: MissingPreview[];
  unconfirmed: MissingPreview[];
  tasks: EnqueueReceipt[];
  issues: EnqueueIssue[];
}

function variantPayloadKey(variant: MissingPreview): string {
  return JSON.stringify(canonicalizeVariants([variant])[0]);
}

interface VariantGroups {
  unique: Map<string, MissingPreview>;
  conflicts: Map<string, MissingPreview[]>;
}

/**
 * Canonicalize a complete payload before grouping it by preview identity. Exact duplicate
 * payloads are harmless; different payloads sharing an identity are not safe to confirm.
 */
function groupVariants(variants: readonly MissingPreview[]): VariantGroups {
  const grouped = new Map<string, MissingPreview[]>();
  for (const preview of canonicalizeVariants(variants)) {
    const identity = getPreviewIdentity(
      preview.sizeKey,
      preview.format,
      preview.filters,
    );
    const group = grouped.get(identity);
    if (group) {
      group.push(preview);
    } else {
      grouped.set(identity, [preview]);
    }
  }

  const unique = new Map<string, MissingPreview>();
  const conflicts = new Map<string, MissingPreview[]>();
  for (const [identity, previews] of grouped) {
    if (previews.length === 1) {
      unique.set(identity, previews[0]);
    } else {
      conflicts.set(identity, previews);
    }
  }
  return { unique, conflicts };
}

/**
 * Strict counterpart to enqueue(). A dispatch lock is only an optimization: losing it is
 * never reported as accepted. Coverage is accepted only from a non-null enqueue receipt or
 * from an optional transport findActive() proof.
 */
export async function enqueueConfirmed(
  resizer: Resizer,
  mediaId: string,
  pipeline: string,
  missing: MissingPreview[],
): Promise<ConfirmedEnqueueResult> {
  const transport = resizer.transport;
  const canonical = canonicalizeVariants(missing);
  if (!transport) {
    return {
      accepted: [],
      unconfirmed: canonical,
      tasks: [],
      issues: [
        {
          code: 'RESIZE_ENQUEUE_NO_TRANSPORT',
          message: 'no queue transport is configured',
          retryable: false,
          previews: canonical,
        },
      ],
    };
  }

  const requestedGroups = groupVariants(canonical);
  const byIdentity = requestedGroups.unique;
  const conflicts = [...requestedGroups.conflicts.values()].flat();
  const winners: MissingPreview[] = [];
  const winnerKeys: string[] = [];
  const unresolved = new Map(byIdentity);
  const issues: EnqueueIssue[] = [];
  if (conflicts.length > 0) {
    issues.push({
      code: 'RESIZE_ENQUEUE_VARIANT_CONFLICT',
      message:
        'multiple variant payloads share one preview identity; none can be confirmed safely',
      retryable: false,
      previews: conflicts,
    });
  }
  const lockContended: MissingPreview[] = [];
  const lockFailed: MissingPreview[] = [];
  const dispatchTtlMs = getResizeConfig().queue.lockTtlMs.dispatch;

  for (const [identity, preview] of byIdentity) {
    const lockKey = `resize_dispatch:${mediaId}:${identity}`;
    try {
      if (await resizer.lockProvider.acquire(lockKey, dispatchTtlMs)) {
        winners.push(preview);
        winnerKeys.push(lockKey);
      } else {
        lockContended.push(preview);
      }
    } catch (error) {
      getApp().logger.error(
        `resize enqueueRequired: dispatch-lock acquire failed for ${lockKey}`,
        error,
      );
      lockFailed.push(preview);
    }
  }

  const accepted = new Map<string, MissingPreview>();
  const tasks: EnqueueReceipt[] = [];
  const activeReceiptConflicts = new Map<string, MissingPreview>();
  if (winners.length > 0) {
    try {
      const { taskId } = await transport.enqueue({
        mediaId,
        pipeline,
        previews: winners,
      });
      if (typeof taskId !== 'string' || taskId.length === 0) {
        issues.push({
          code: 'RESIZE_ENQUEUE_UNCONFIRMED',
          message: 'transport returned a null taskId',
          retryable: true,
          previews: winners,
        });
        await releaseAll(resizer, winnerKeys);
      } else {
        const receipt = { taskId, previews: winners };
        tasks.push(receipt);
        for (const preview of winners) {
          const identity = getPreviewIdentity(
            preview.sizeKey,
            preview.format,
            preview.filters,
          );
          accepted.set(identity, preview);
          unresolved.delete(identity);
        }
      }
    } catch (error) {
      getApp().logger.error(
        `resize enqueueRequired: transport.enqueue threw for media ${mediaId}`,
        error,
      );
      issues.push({
        code: 'RESIZE_ENQUEUE_TRANSPORT_FAILED',
        message: 'transport enqueue failed; outcome is unconfirmed',
        retryable: true,
        previews: winners,
      });
      await releaseAll(resizer, winnerKeys);
    }
  }

  if (unresolved.size > 0 && transport.findActive) {
    try {
      const confirmations = await transport.findActive({
        mediaId,
        pipeline,
        previews: [...unresolved.values()],
      });
      const unresolvedByPayload = new Map(
        [...unresolved.entries()].map(([identity, preview]) => [
          variantPayloadKey(preview),
          { identity, preview },
        ]),
      );
      for (const receipt of confirmations) {
        if (
          typeof receipt.taskId !== 'string' ||
          receipt.taskId.trim().length === 0
        ) {
          continue;
        }
        // Inspect the complete receipt before matching any requested payload. Filtering to
        // the requested payload first would hide a second payload that makes the identity
        // ambiguous in the active task.
        const receiptGroups = groupVariants(receipt.previews);
        for (const identity of receiptGroups.conflicts.keys()) {
          const requested = unresolved.get(identity);
          if (requested && !activeReceiptConflicts.has(identity)) {
            activeReceiptConflicts.set(identity, requested);
          }
        }
        const covered: MissingPreview[] = [];
        for (const preview of receiptGroups.unique.values()) {
          const requested = unresolvedByPayload.get(variantPayloadKey(preview));
          if (requested) {
            accepted.set(requested.identity, requested.preview);
            unresolved.delete(requested.identity);
            unresolvedByPayload.delete(variantPayloadKey(preview));
            covered.push(requested.preview);
          }
        }
        if (covered.length > 0) {
          tasks.push({ taskId: receipt.taskId, previews: covered });
        }
      }
    } catch (error) {
      getApp().logger.error(
        `resize enqueueRequired: active-task confirmation failed for media ${mediaId}`,
        error,
      );
      issues.push({
        code: 'RESIZE_ENQUEUE_CONFIRM_FAILED',
        message: 'transport could not confirm active task coverage',
        retryable: true,
        previews: [...unresolved.values()],
      });
    }
  }

  const unconfirmed = [...unresolved.values(), ...conflicts];
  const receiptConflictPreviews = [...activeReceiptConflicts.entries()]
    .filter(([identity]) => unresolved.has(identity))
    .map(([, preview]) => preview);
  if (receiptConflictPreviews.length > 0) {
    issues.push({
      code: 'RESIZE_ENQUEUE_VARIANT_CONFLICT',
      message:
        'multiple active-task payloads share one preview identity; none can be confirmed safely',
      retryable: false,
      previews: receiptConflictPreviews,
    });
  }
  const unresolvedIdentities = new Set(
    unconfirmed.map((preview) =>
      getPreviewIdentity(preview.sizeKey, preview.format, preview.filters),
    ),
  );
  const remainingContended = lockContended.filter((preview) =>
    unresolvedIdentities.has(
      getPreviewIdentity(preview.sizeKey, preview.format, preview.filters),
    ),
  );
  const remainingFailed = lockFailed.filter((preview) =>
    unresolvedIdentities.has(
      getPreviewIdentity(preview.sizeKey, preview.format, preview.filters),
    ),
  );
  if (remainingContended.length > 0) {
    issues.push({
      code: 'RESIZE_ENQUEUE_LOCK_CONTENDED',
      message:
        'dispatch lock is held but no active task coverage was confirmed',
      retryable: true,
      previews: remainingContended,
    });
  }
  if (remainingFailed.length > 0) {
    issues.push({
      code: 'RESIZE_ENQUEUE_LOCK_FAILED',
      message: 'dispatch lock could not be acquired or confirmed',
      retryable: true,
      previews: remainingFailed,
    });
  }

  return {
    accepted: [...accepted.values()],
    unconfirmed,
    tasks,
    issues,
  };
}

/** Best-effort release of every given lock key; a failing release is logged, not thrown. */
async function releaseAll(resizer: Resizer, lockKeys: string[]): Promise<void> {
  for (const key of lockKeys) {
    try {
      await resizer.lockProvider.release(key);
    } catch (err) {
      getApp().logger.error(
        `resize enqueue: failed to release dispatch lock ${key}`,
        err,
      );
    }
  }
}
