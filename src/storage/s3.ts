// S3 storage driver (05 · §10.5) — SHIPPED, optional peer deps. A class that keeps its
// bucket/URL options in a `#private` field (engine-enforced, not a compile-time convention, so a
// JS host cannot read the bucket config off the instance) and constructs (and memoizes) ONE
// `S3Client` on first
// I/O use — unless the host brings its own via `opts.client`. `publicUrl` is PURE (no client,
// no I/O — the read path calls it). Credentials are NEVER options — they resolve via the
// standard AWS provider chain.
//
// SUBPATH-ONLY ENTRY, STATIC SDK IMPORTS (05 · §10.5): `@aws-sdk/client-s3` and
// `@aws-sdk/s3-request-presigner` are imported plainly at the top of this module. This is safe
// precisely because this driver is NOT re-exported from the main package entry (02 · §6) —
// hosts import `@adaptivestone/framework-module-resize/storage/s3.js` directly, so the optional
// peers are resolved ONLY when this subpath is imported, and a missing SDK fails loudly at the
// host's own import line at bootstrap (no dynamic import(), no lazy loaders).
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ResizeSecurityError, ResizeStorageError } from '../errors.ts';
import type { StorageRef } from '../types.d.ts';
import type { ResizeStorage } from './AbstractStorage.ts';
import { validateLogicalKey, validateNamespace } from './placement.ts';

interface S3StorageRef {
  bucket: string;
  key: string;
  namespace?: string;
}

export interface S3StorageOptions {
  bucketPublic: string; // previews land here (upload visibility 'public')
  bucketPrivate?: string; // required for visibility:'private'; must differ from bucketPublic
  publicBaseUrl?: string; // CDN/base URL for public objects, e.g. 'https://cdn.example.com'
  /** @deprecated Use `publicBaseUrl`. Same string; kept for one minor. */
  publicUrl?: string;
  region?: string;
  endpoint?: string; // S3-compatible: MinIO / localstack / R2
  forcePathStyle?: boolean;
  // Bring-your-own configured client: a custom credential provider, proxy, retry strategy,
  // or a shared instance. When absent the driver constructs one from
  // region/endpoint/forcePathStyle. (This option is also the injection point exercised by the
  // tests — the driver ships NO test-only seams.)
  client?: S3Client;
}

export class S3Storage implements ResizeStorage {
  readonly #opts: S3StorageOptions;
  // Memoized per instance (a host may construct more than one driver). A host-provided
  // `opts.client` short-circuits construction. Synchronous now that the SDK is a static
  // import — built lazily on first I/O use.
  #client: S3Client | undefined;

  constructor(opts: S3StorageOptions) {
    // erasableSyntaxOnly: no parameter properties — assign fields explicitly.
    this.#opts = opts;
  }

  #getClient(): S3Client {
    if (this.#opts.client) {
      return this.#opts.client;
    }
    this.#client ??= new S3Client({
      // region/endpoint/forcePathStyle only when provided (else the SDK's own defaults
      // / the AWS provider chain apply).
      ...(this.#opts.region !== undefined ? { region: this.#opts.region } : {}),
      ...(this.#opts.endpoint !== undefined
        ? { endpoint: this.#opts.endpoint }
        : {}),
      ...(this.#opts.forcePathStyle !== undefined
        ? { forcePathStyle: this.#opts.forcePathStyle }
        : {}),
    });
    return this.#client;
  }

  #assertAllowedBucket(bucket: string): void {
    if (
      bucket === this.#opts.bucketPublic ||
      bucket === this.#opts.bucketPrivate
    ) {
      return;
    }
    throw new ResizeSecurityError(
      `resize s3: ref.bucket "${bucket}" is not an allowlisted bucket (bucketPublic/bucketPrivate) — refusing cross-bucket access (05 · §10.5)`,
      { code: 'RESIZE_S3_BUCKET_NOT_ALLOWED' },
    );
  }

  #ref(value: StorageRef): S3StorageRef {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ResizeSecurityError('resize s3: invalid storage ref', {
        code: 'RESIZE_S3_REF_INVALID',
      });
    }
    const ref = value as Record<string, unknown>;
    if (
      typeof ref.bucket !== 'string' ||
      !ref.bucket ||
      typeof ref.key !== 'string'
    ) {
      throw new ResizeSecurityError('resize s3: invalid storage ref', {
        code: 'RESIZE_S3_REF_INVALID',
      });
    }
    this.#assertAllowedBucket(ref.bucket);
    validateLogicalKey(ref.key);
    const namespace = validateNamespace(ref.namespace);
    if (namespace && !ref.key.startsWith(`${namespace}/`)) {
      throw new ResizeSecurityError('resize s3: namespace does not match key', {
        code: 'RESIZE_S3_REF_INVALID',
      });
    }
    return ref as unknown as S3StorageRef;
  }

  // Upload a NEW object. Route by visibility (NO per-object ACL — public access is a
  // bucket policy). The driver owns the physical bucket; returns the ref to persist.
  async upload({
    key,
    body,
    contentType,
    visibility,
    namespace,
    parentRef,
  }: {
    key: string;
    body: Buffer | Uint8Array;
    contentType: string;
    visibility: 'public' | 'private';
    namespace?: string;
    parentRef?: StorageRef;
  }): Promise<StorageRef> {
    if (parentRef !== undefined && namespace !== undefined) {
      throw new ResizeSecurityError(
        'resize s3: namespace and parentRef conflict',
        {
          code: 'RESIZE_S3_HINT_CONFLICT',
        },
      );
    }
    if (parentRef === null) {
      throw new ResizeSecurityError('resize s3: invalid parentRef', {
        code: 'RESIZE_S3_REF_INVALID',
      });
    }
    const grouping = validateNamespace(
      parentRef === undefined ? namespace : this.#ref(parentRef).namespace,
    );
    if (visibility !== 'public' && visibility !== 'private') {
      throw new ResizeSecurityError('resize s3: invalid visibility', {
        code: 'RESIZE_S3_VISIBILITY_INVALID',
      });
    }
    const physicalKey = grouping
      ? `${grouping}/${validateLogicalKey(key)}`
      : validateLogicalKey(key);
    if (Buffer.byteLength(physicalKey, 'utf8') > 1024) {
      throw new ResizeSecurityError(
        'resize s3: object key exceeds 1024 bytes',
        {
          code: 'RESIZE_S3_KEY_TOO_LONG',
        },
      );
    }
    const bucket =
      visibility === 'public'
        ? this.#opts.bucketPublic
        : (this.#opts.bucketPrivate ?? this.#opts.bucketPublic);
    if (visibility === 'private' && bucket === this.#opts.bucketPublic) {
      throw new ResizeSecurityError(
        'resize s3: private upload requires a distinct private bucket',
        { code: 'RESIZE_S3_PRIVATE_BUCKET_REQUIRED' },
      );
    }
    await this.#getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: physicalKey,
        Body: body,
        ContentType: contentType,
      }),
    );
    return {
      bucket,
      key: physicalKey,
      ...(grouping === undefined ? {} : { namespace: grouping }),
    };
  }

  async download(ref: StorageRef): Promise<Buffer> {
    const { bucket, key } = this.#ref(ref);
    const out = await this.#getClient().send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const stream = out.Body;
    if (!stream) {
      throw new ResizeStorageError(
        `resize s3: empty body for ${bucket}/${key}`,
        { code: 'RESIZE_S3_EMPTY_BODY' },
      );
    }
    const bytes = await stream.transformToByteArray();
    return Buffer.from(bytes);
  }

  canServeOriginalPublicly(ref: StorageRef): boolean {
    const { bucket } = this.#ref(ref);
    return bucket === this.#opts.bucketPublic;
  }

  // PURE string building — no SDK, no I/O (called on the read path). Three forms:
  // explicit publicUrl base → CDN; endpoint/forcePathStyle → path-style; else
  // virtual-hosted.
  publicUrl(ref: StorageRef): string {
    const { bucket, key } = this.#ref(ref);
    // A ref explicitly pointing at the configured private bucket must never be turned into a
    // public CDN URL. The engine normally prevents this call; keep the driver safe when a host
    // calls publicUrl directly too. If both buckets are the same, that bucket is intentionally
    // public and the check below does not reject it.
    if (
      this.#opts.bucketPrivate !== undefined &&
      bucket === this.#opts.bucketPrivate &&
      bucket !== this.#opts.bucketPublic
    ) {
      throw new ResizeSecurityError(
        `resize s3: refusing public URL for private bucket "${bucket}"`,
        { code: 'RESIZE_S3_PRIVATE_ORIGINAL_PUBLIC_URL' },
      );
    }
    const publicBase = this.#opts.publicBaseUrl ?? this.#opts.publicUrl;
    if (publicBase) {
      return `${publicBase.replace(/\/+$/, '')}/${key}`;
    }
    if (this.#opts.endpoint !== undefined || this.#opts.forcePathStyle) {
      const base = (this.#opts.endpoint ?? '').replace(/\/+$/, '');
      return `${base}/${bucket}/${key}`;
    }
    return `https://${bucket}.s3.${this.#opts.region ?? 'us-east-1'}.amazonaws.com/${key}`;
  }

  // Time-limited signed URL for owner/admin reads of a private original.
  async signedUrl(ref: StorageRef, ttlSeconds: number): Promise<string> {
    const { bucket, key } = this.#ref(ref);
    return getSignedUrl(
      this.#getClient(),
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }
}
