// Hosts `instanceof` these instead of guessing from an empty `created` array.
//
// EVERY error this module throws extends `ResizeError`, so ONE check separates "the resize
// module rejected this" from "sharp blew up" / "S3 timed out" / "mongo went away". The subclass
// then answers the only question a catch block actually has — what do I DO about it:
//   ResizeSetupError    — the wiring is wrong; fix the bootstrap code
//   ResizeConfigError   — host config is invalid; crash at boot
//   ResizeMediaError    — this record is unusable; skip it in the request path (the task queue
//                         still retries it unless it carries `retryable: false`)
//   ResizeGenerateError — the operation produced nothing
//   ResizeOriginalError — uploaded original bytes are invalid/unsupported/outside policy
//   ResizeStorageError  — transient I/O; a retry may help
//   ResizeSecurityError — a refusal (traversal, cross-bucket); never retry, log loudly
//
// The subclass guides a host's catch block; the task queue retries every error unless it is a
// ResizeError carrying `retryable: false`. That per-throw field means another delivery of the
// same task cannot succeed, so the consumer dead-letters it at once. The consumer reads the field
// on an error with the brand below, never by class, so an error from a duplicate copy of this
// package counts too; an error from another library is retried whatever fields it carries.

/**
 * Brand for cross-copy identification. `instanceof` silently returns FALSE when two copies of
 * this package land in one `node_modules` tree (two class identities sharing one name) — which
 * is precisely when a host most needs the check to work. `isResizeError` tests this symbol
 * instead of the prototype chain. `Symbol.for` (not `Symbol`) so separate copies agree on the key.
 */
const RESIZE_ERROR = Symbol.for('@adaptivestone/framework-module-resize.error');

export interface ResizeErrorOptions {
  code?: string;
  cause?: unknown;
  /** Default `true`. `false`: no retry can help, the task queue dead-letters at once. */
  retryable?: boolean;
}

/** Base for every error this module throws. */
export class ResizeError extends Error {
  /** Stable machine-readable discriminator — survives minification AND duplicate copies. */
  readonly code: string;
  /** `false`: no retry can help, the consumer dead-letters at once. Enumerable, for logs. */
  readonly retryable: boolean;
  readonly [RESIZE_ERROR] = true;

  constructor(message: string, opts?: ResizeErrorOptions) {
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
    this.retryable = opts?.retryable ?? true;
  }

  /** Prefer this over `instanceof` when the error may have crossed a package boundary. */
  static isResizeError(err: unknown): err is ResizeError {
    return typeof err === 'object' && err !== null && RESIZE_ERROR in err;
  }
}

/**
 * Bootstrap/wiring is wrong — a programmer error; fix the code. A queued task still retries: a
 * worker deployed with the fix (e.g. a newly registered pipeline) can run it.
 */
export class ResizeSetupError extends ResizeError {
  constructor(message: string, opts?: ResizeErrorOptions) {
    super(message, { ...opts, code: opts?.code ?? 'RESIZE_SETUP' });
  }
}

/** Host config is invalid or violates an invariant — crash at boot, do not degrade. */
export class ResizeConfigError extends ResizeError {
  constructor(message: string, opts?: ResizeErrorOptions) {
    super(message, { ...opts, code: opts?.code ?? 'RESIZE_CONFIG' });
  }
}

/** Transient storage I/O — a retry may help. */
export class ResizeStorageError extends ResizeError {
  constructor(message: string, opts?: ResizeErrorOptions) {
    super(message, { ...opts, code: opts?.code ?? 'RESIZE_STORAGE' });
  }
}

/**
 * A deliberate refusal (path traversal, cross-bucket access). NEVER retry (`retryable` defaults
 * to `false`); log loudly.
 */
export class ResizeSecurityError extends ResizeError {
  constructor(message: string, opts?: ResizeErrorOptions) {
    super(message, {
      ...opts,
      code: opts?.code ?? 'RESIZE_SECURITY',
      retryable: opts?.retryable ?? false,
    });
  }
}

/**
 * This media record is unusable — skip it in the request path. A queued task that fails with one
 * is retried unless the thrower sets `retryable: false` (as the source and SVG checks do, when the
 * same document can never succeed).
 */
export class ResizeMediaError extends ResizeError {
  readonly mediaId: string | undefined;

  constructor(
    message: string,
    opts?: ResizeErrorOptions & { mediaId?: string },
  ) {
    super(message, { ...opts, code: opts?.code ?? 'RESIZE_MEDIA' });
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
      // A retry would load the same row without an original again.
      { mediaId, code: 'RESIZE_NO_ORIGINAL', retryable: false },
    );
  }
}

/** `generate` requested variants and every one failed (nothing created). */
export class ResizeGenerateError extends ResizeError {
  readonly mediaId: string;
  readonly failed: number;
  readonly requested: number;
  readonly missing: string[];

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
    missing?: string[];
  }) {
    super(
      opts.message ??
        `resize generate: media ${opts.mediaId} produced 0 previews with ${opts.failed} variant error(s) of ${opts.requested} requested`,
      { code: opts.code ?? 'RESIZE_GENERATE_FAILED' },
    );
    this.mediaId = opts.mediaId;
    this.failed = opts.failed;
    this.requested = opts.requested;
    this.missing = opts.missing ?? [];
  }
}

/** Original-upload input is empty, malformed, unsupported, or over a configured limit. */
export class ResizeOriginalError extends ResizeMediaError {
  constructor(message: string, opts?: ResizeErrorOptions) {
    super(message, { ...opts, code: opts?.code ?? 'RESIZE_ORIGINAL_INVALID' });
  }
}
