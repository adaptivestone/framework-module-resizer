// Test-only fakes for the driver contracts: a ResizeDatabase built from parts, in-memory locks, and
// a complete in-memory TaskQueue (the reference for the contract's semantics: request
// de-duplication, oldest-first claims, fenced leases, retry times and dead tasks).
import type { ResizeDatabase } from '../contracts/database.ts';
import {
  type ClaimedTask,
  type NewTask,
  TaskQueue,
} from '../contracts/taskQueue.ts';
import type {
  EnqueueReceipt,
  MediaLike,
  Preview,
  QueueTimingOptions,
} from '../types.d.ts';

export interface FakeLocks {
  acquire(key: string, ttlMs: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

/** In-memory locks (no expiry). */
export function memoryLocks(): FakeLocks {
  const held = new Set<string>();
  return {
    acquire: async (key) => {
      if (held.has(key)) {
        return false;
      }
      held.add(key);
      return true;
    },
    release: async (key) => {
      held.delete(key);
    },
  };
}

/**
 * A ResizeDatabase from optional parts; missing parts are harmless in-memory stand-ins. The default
 * appendPreviews follows the database contract: it keeps one row per preview identity in
 * `previews` (per media id; pass a map to seed or inspect it) and resolves with the previews it
 * stored. A preview without an identity is always stored.
 */
export function fakeDb(
  parts: {
    load?: (mediaId: string) => Promise<MediaLike | null>;
    appendPreviews?: ResizeDatabase['appendPreviews'];
    previews?: Map<string, Preview[]>;
    locks?: FakeLocks;
    tasks?: TaskQueue;
    verify?: () => void | Promise<void>;
  } = {},
): ResizeDatabase {
  const locks = parts.locks ?? memoryLocks();
  const rows = parts.previews ?? new Map<string, Preview[]>();
  const appendPreviews = async (mediaId: string, previews: Preview[]) => {
    const media = rows.get(mediaId) ?? [];
    rows.set(mediaId, media);
    const stored: Preview[] = [];
    for (const preview of previews) {
      if (
        preview.identity !== undefined &&
        media.some((row) => row.identity === preview.identity)
      ) {
        continue;
      }
      media.push(preview);
      stored.push(preview);
    }
    return stored;
  };
  return {
    loadMedia: parts.load ?? (async () => null),
    appendPreviews: parts.appendPreviews ?? appendPreviews,
    acquireLock: (key, ttlMs) => locks.acquire(key, ttlMs),
    releaseLock: (key) => locks.release(key),
    ...(parts.tasks ? { tasks: parts.tasks } : {}),
    ...(parts.verify ? { verify: parts.verify } : {}),
  };
}

interface Row {
  id: string;
  task: NewTask;
  status: 'pending' | 'processing' | 'completed' | 'dead';
  attempts: number;
  token: string | null;
  leaseUntil: number;
  availableAt: number;
  error?: string;
}

/** A complete in-memory TaskQueue. `rows` and `added` are open for assertions. */
export class MemoryTaskQueue extends TaskQueue {
  readonly rows: Row[] = [];
  readonly added: NewTask[] = [];
  readonly #timing: Partial<QueueTimingOptions>;
  #seq = 0;

  constructor(opts: { timing?: Partial<QueueTimingOptions> } = {}) {
    super();
    this.#timing = opts.timing ?? {};
  }

  getTiming(): Partial<QueueTimingOptions> {
    return this.#timing;
  }

  #active(row: Row): boolean {
    return row.status === 'pending' || row.status === 'processing';
  }

  async add(task: NewTask): Promise<{ taskId: string | null }> {
    this.added.push(task);
    const existing = this.rows.find(
      (row) =>
        this.#active(row) &&
        row.task.mediaId === task.mediaId &&
        row.task.pipeline === task.pipeline &&
        row.task.requestKey === task.requestKey,
    );
    if (existing) {
      return { taskId: existing.id };
    }
    this.#seq += 1;
    const row: Row = {
      id: `task-${this.#seq}`,
      task,
      status: 'pending',
      attempts: 0,
      token: null,
      leaseUntil: 0,
      availableAt: 0,
    };
    this.rows.push(row);
    return { taskId: row.id };
  }

  async claim(queue: string, leaseMs: number): Promise<ClaimedTask | null> {
    const now = Date.now();
    const row = this.rows.find(
      (r) =>
        r.task.queue === queue &&
        ((r.status === 'pending' && r.availableAt <= now) ||
          (r.status === 'processing' && r.leaseUntil < now)),
    );
    if (!row) {
      return null;
    }
    this.#seq += 1;
    row.status = 'processing';
    row.attempts += 1;
    row.token = `lease-${this.#seq}`;
    row.leaseUntil = now + leaseMs;
    return {
      taskId: row.id,
      resizer: row.task.resizer,
      queue: row.task.queue,
      mediaId: row.task.mediaId,
      pipeline: row.task.pipeline,
      previews: row.task.previews,
      token: row.token,
      attempts: row.attempts,
    };
  }

  #held(task: ClaimedTask): Row | undefined {
    return this.rows.find(
      (r) =>
        r.id === task.taskId &&
        r.status === 'processing' &&
        r.token === task.token,
    );
  }

  async renew(task: ClaimedTask, leaseMs: number): Promise<boolean> {
    const row = this.#held(task);
    if (!row) {
      return false;
    }
    row.leaseUntil = Date.now() + leaseMs;
    return true;
  }

  async complete(task: ClaimedTask): Promise<boolean> {
    const row = this.#held(task);
    if (!row) {
      return false;
    }
    row.status = 'completed';
    return true;
  }

  async fail(
    task: ClaimedTask,
    next: { retryAt: Date } | 'dead',
    error: string,
  ): Promise<boolean> {
    const row = this.#held(task);
    if (!row) {
      return false;
    }
    row.error = error;
    if (next === 'dead') {
      row.status = 'dead';
    } else {
      row.status = 'pending';
      row.token = null;
      row.availableAt = next.retryAt.getTime();
    }
    return true;
  }

  async findActive(query: {
    resizer: string;
    mediaId: string;
    pipeline: string;
  }): Promise<EnqueueReceipt[]> {
    return this.rows
      .filter(
        (r) =>
          this.#active(r) &&
          r.task.resizer === query.resizer &&
          r.task.mediaId === query.mediaId &&
          r.task.pipeline === query.pipeline,
      )
      .map((r) => ({ taskId: r.id, previews: r.task.previews }));
  }
}
