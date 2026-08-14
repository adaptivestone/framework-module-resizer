// Hosts `instanceof` these instead of guessing from an empty `created` array.

/** `generate` was called on a media document with no `original`. */
export class ResizeNoOriginalError extends Error {
  readonly mediaId: string;

  constructor(mediaId: string) {
    super(
      `resize generate: media ${mediaId} has no original — upload the source before generate()`,
    );
    this.name = 'ResizeNoOriginalError';
    this.mediaId = mediaId;
  }
}

/** `generate` requested variants and every one failed (nothing created). */
export class ResizeGenerateError extends Error {
  readonly mediaId: string;
  readonly failed: number;
  readonly requested: number;

  constructor(opts: { mediaId: string; failed: number; requested: number }) {
    super(
      `resize generate: media ${opts.mediaId} produced 0 previews with ${opts.failed} variant error(s) of ${opts.requested} requested`,
    );
    this.name = 'ResizeGenerateError';
    this.mediaId = opts.mediaId;
    this.failed = opts.failed;
    this.requested = opts.requested;
  }
}
