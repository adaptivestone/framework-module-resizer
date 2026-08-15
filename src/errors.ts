// Hosts `instanceof` these instead of guessing from an empty `created` array.
//
// EVERY error this module throws extends `ResizeError`, so ONE check separates "the resize
// module rejected this" from "sharp blew up" / "S3 timed out" / "mongo went away". The subclass
// then answers the only question a catch block actually has — what do I DO about it:
//   ResizeSetupError    — the wiring is wrong; no retry helps, fix the bootstrap code
//   ResizeConfigError   — host config is invalid; crash at boot
//   ResizeMediaError    — this record is unusable; skip it, do not retry
//   ResizeGenerateError — the operation produced nothing
//   ResizeStorageError  — transient I/O; a retry may help
//   ResizeSecurityError — a refusal (traversal, cross-bucket); never retry, log loudly
//
// Deliberately NOT branded: the mongo transport's `new Error(err)` that re-hydrates a PERSISTED
// failure string for the `onTaskDeadLettered` observer — that failure usually originated in host
// pipeline code, so claiming module provenance for it would be a lie.

/**
 * Brand for cross-copy identification. `instanceof` silently returns FALSE when two copies of
 * this package land in one `node_modules` tree (two class identities sharing one name) — which
 * is precisely when a host most needs the check to work. `isResizeError` tests this symbol
 * instead of the prototype chain. `Symbol.for` (not `Symbol`) so separate copies agree on the key.
 */
const RESIZE_ERROR = Symbol.for('@adaptivestone/framework-module-resize.error');

/** Base for every error this module throws. */
export class ResizeError extends Error {
  /** Stable machine-readable discriminator — survives minification AND duplicate copies. */
  readonly code: string;
  readonly [RESIZE_ERROR] = true;

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    // Pass the options bag ONLY when there is a cause: `{ cause: undefined }` defines an own
    // `cause` property set to undefined, which serializes differently from having none at all.
    super(
      message,
      opts?.cause === undefined ? undefined : { cause: opts.cause },
    );
    // `new.target` is the constructor actually invoked, so every subclass reports its own name
    // without repeating the literal. Enumerable (as before this refactor), so structured logs
    // that JSON.stringify the error still carry it.
    this.name = new.target.name;
    this.code = opts?.code ?? 'RESIZE_ERROR';
  }

  /** Prefer this over `instanceof` when the error may have crossed a package boundary. */
  static isResizeError(err: unknown): err is ResizeError {
    return typeof err === 'object' && err !== null && RESIZE_ERROR in err;
  }
}

/** Bootstrap/wiring is wrong — a programmer error. Retrying will never help. */
export class ResizeSetupError extends ResizeError {
  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message, { code: opts?.code ?? 'RESIZE_SETUP', cause: opts?.cause });
  }
}

/** Host config is invalid or violates an invariant — crash at boot, do not degrade. */
export class ResizeConfigError extends ResizeError {
  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message, { code: opts?.code ?? 'RESIZE_CONFIG', cause: opts?.cause });
  }
}

/** Transient storage I/O — a retry may help. */
export class ResizeStorageError extends ResizeError {
  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message, {
      code: opts?.code ?? 'RESIZE_STORAGE',
      cause: opts?.cause,
    });
  }
}

/** A deliberate refusal (path traversal, cross-bucket access). NEVER retry; log loudly. */
export class ResizeSecurityError extends ResizeError {
  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message, {
      code: opts?.code ?? 'RESIZE_SECURITY',
      cause: opts?.cause,
    });
  }
}

/** This media record is unusable — skip it. Retrying the same document changes nothing. */
export class ResizeMediaError extends ResizeError {
  readonly mediaId: string | undefined;

  constructor(
    message: string,
    opts?: { mediaId?: string; code?: string; cause?: unknown },
  ) {
    super(message, { code: opts?.code ?? 'RESIZE_MEDIA', cause: opts?.cause });
    this.mediaId = opts?.mediaId;
  }
}

/** `generate` was called on a media document with no `original`. */
export class ResizeNoOriginalError extends ResizeMediaError {
  // Narrows the base's `string | undefined` — this subclass ALWAYS has one. `declare` is
  // type-only (erased), so it adds no runtime field and the base's assignment stands.
  declare readonly mediaId: string;

  constructor(mediaId: string) {
    super(
      `resize generate: media ${mediaId} has no original — upload the source before generate()`,
      { mediaId, code: 'RESIZE_NO_ORIGINAL' },
    );
  }
}

/** `generate` requested variants and every one failed (nothing created). */
export class ResizeGenerateError extends ResizeError {
  readonly mediaId: string;
  readonly failed: number;
  readonly requested: number;

  constructor(opts: {
    mediaId: string;
    failed: number;
    requested: number;
    /**
     * Overrides the default text. The QUEUED worker hits the same condition but needs its own
     * wording — "failing for retry/dead-letter" is the operational context an operator reading
     * the dead-letter queue actually needs, and it must not be flattened into the eager phrasing.
     */
    message?: string;
    code?: string;
  }) {
    super(
      opts.message ??
        `resize generate: media ${opts.mediaId} produced 0 previews with ${opts.failed} variant error(s) of ${opts.requested} requested`,
      { code: opts.code ?? 'RESIZE_GENERATE_FAILED' },
    );
    this.mediaId = opts.mediaId;
    this.failed = opts.failed;
    this.requested = opts.requested;
  }
}
