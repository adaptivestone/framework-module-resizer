// S3 storage driver (05 · §10.5) — SHIPPED, optional peer deps. A class that keeps its
// bucket/URL options in a private field and constructs (and memoizes) ONE `S3Client` on first
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
import type { StorageRef } from '../types.d.ts';
import type { ResizeStorage } from './AbstractStorage.ts';

export interface S3StorageOptions {
  bucketPublic: string; // previews land here (upload visibility 'public')
  bucketPrivate?: string; // originals ('private'); defaults to bucketPublic
  publicUrl?: string; // CDN/base URL for public objects, e.g. 'https://cdn.example.com'
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
  private readonly opts: S3StorageOptions;
  // Memoized per instance (a host may construct more than one driver). A host-provided
  // `opts.client` short-circuits construction. Synchronous now that the SDK is a static
  // import — built lazily on first I/O use.
  private client: S3Client | undefined;

  constructor(opts: S3StorageOptions) {
    // erasableSyntaxOnly: no parameter properties — assign fields explicitly.
    this.opts = opts;
  }

  private getClient(): S3Client {
    if (this.opts.client) {
      return this.opts.client;
    }
    this.client ??= new S3Client({
      // region/endpoint/forcePathStyle only when provided (else the SDK's own defaults
      // / the AWS provider chain apply).
      ...(this.opts.region !== undefined ? { region: this.opts.region } : {}),
      ...(this.opts.endpoint !== undefined
        ? { endpoint: this.opts.endpoint }
        : {}),
      ...(this.opts.forcePathStyle !== undefined
        ? { forcePathStyle: this.opts.forcePathStyle }
        : {}),
    });
    return this.client;
  }

  // Upload a NEW object. Route by visibility (NO per-object ACL — public access is a
  // bucket policy). The driver owns the physical bucket; returns the ref to persist.
  async upload({
    key,
    body,
    contentType,
    visibility,
  }: {
    key: string;
    body: Buffer | Uint8Array;
    contentType: string;
    visibility: 'public' | 'private';
  }): Promise<StorageRef> {
    const bucket =
      visibility === 'public'
        ? this.opts.bucketPublic
        : (this.opts.bucketPrivate ?? this.opts.bucketPublic);
    await this.getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { bucket, key };
  }

  // Download by stored locator (the worker's original). ref.bucket wins, then the
  // private/public fallbacks.
  async download(ref: StorageRef): Promise<Buffer> {
    const bucket =
      ref.bucket ?? this.opts.bucketPrivate ?? this.opts.bucketPublic;
    const out = await this.getClient().send(
      new GetObjectCommand({ Bucket: bucket, Key: ref.key }),
    );
    const stream = out.Body;
    if (!stream) {
      throw new Error(`resize s3: empty body for ${bucket}/${ref.key}`);
    }
    const bytes = await stream.transformToByteArray();
    return Buffer.from(bytes);
  }

  // PURE string building — no SDK, no I/O (called on the read path). Three forms:
  // explicit publicUrl base → CDN; endpoint/forcePathStyle → path-style; else
  // virtual-hosted. bucket = ref.bucket ?? bucketPublic.
  publicUrl(ref: StorageRef): string {
    const bucket = ref.bucket ?? this.opts.bucketPublic;
    if (this.opts.publicUrl) {
      return `${this.opts.publicUrl.replace(/\/+$/, '')}/${ref.key}`;
    }
    if (this.opts.endpoint !== undefined || this.opts.forcePathStyle) {
      const base = (this.opts.endpoint ?? '').replace(/\/+$/, '');
      return `${base}/${bucket}/${ref.key}`;
    }
    return `https://${bucket}.s3.${this.opts.region ?? 'us-east-1'}.amazonaws.com/${ref.key}`;
  }

  // Time-limited signed URL for owner/admin reads of a private original.
  async signedUrl(ref: StorageRef, ttlSeconds: number): Promise<string> {
    const bucket =
      ref.bucket ?? this.opts.bucketPrivate ?? this.opts.bucketPublic;
    return getSignedUrl(
      this.getClient(),
      new GetObjectCommand({ Bucket: bucket, Key: ref.key }),
      { expiresIn: ttlSeconds },
    );
  }
}
