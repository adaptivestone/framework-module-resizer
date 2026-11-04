// S3 storage driver — SHIPPED, optional peer deps. A class that keeps its
// bucket/URL options in a `#private` field (engine-enforced, not a compile-time convention, so a
// JS host cannot read the bucket config off the instance) and constructs (and memoizes) ONE
// `S3Client` on first
// I/O use — unless the host brings its own via `opts.client`. `publicUrl` is PURE (no client,
// no I/O — the read path calls it). Credentials are NEVER options — they resolve via the
// standard AWS provider chain.
//
// SUBPATH-ONLY ENTRY: `@aws-sdk/client-s3` stays a plain import at the top of this module. This is
// safe precisely because this driver is NOT re-exported from the main package entry — hosts import
// `@adaptivestone/framework-module-resize/drivers/s3.js` directly, so the optional peer is resolved
// ONLY when this subpath is imported, and a missing SDK fails loudly at the host's own import line
// at bootstrap. `@aws-sdk/s3-request-presigner` is loaded only by `signedUrl`, the one thing that
// needs it and that the module itself never calls.
//
// TWO KEY RULES: what this driver writes keeps the strict alphabet of `validateLogicalKey` and
// `validateNamespace`, and a preview never takes a part of a stored key. What it reads may be any
// key a bucket already holds (`validateStoredKey`), since a real library's keys hold clients' file
// names. The SDK encodes such a key itself; `publicUrl` builds a string, so it encodes it here.
import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { DriverContext } from '../contracts/drivers.ts';
import {
  ResizeStorage,
  type StorageDownloadOptions,
} from '../contracts/storage.ts';
import {
  ResizeConfigError,
  ResizeMediaError,
  ResizeSecurityError,
  ResizeSetupError,
  ResizeStorageError,
} from '../errors.ts';
import { optionalString, requiredString } from '../helpers/configSection.ts';
import { missingPackageOf } from '../helpers/peers.ts';
import type { S3StorageConfig, StorageRef } from '../types.d.ts';
import {
  validateLogicalKey,
  validateNamespace,
  validateStoredKey,
} from './placement.ts';

// The Cache-Control header of every public object (see `upload` for why it is safe).
const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';

interface S3StorageRef {
  bucket: string;
  key: string;
  namespace?: string;
}

export interface S3StorageOptions {
  bucketPublic: string; // previews land here (upload visibility 'public')
  bucketPrivate?: string; // required for visibility:'private'; must differ from bucketPublic
  publicBaseUrl?: string; // CDN/base URL for public objects, e.g. 'https://cdn.example.com'
  region?: string;
  endpoint?: string; // S3-compatible: MinIO / localstack / R2
  forcePathStyle?: boolean;
  // Bring-your-own configured client: a custom credential provider, proxy, retry strategy,
  // or a shared instance. When absent the driver constructs one from
  // region/endpoint/forcePathStyle. (This option is also the injection point exercised by the
  // tests — the driver ships NO test-only seams.)
  client?: S3Client;
}

// A key as a URL path: each `/` part as the SDK puts it on the wire. encodeURIComponent leaves
// `!'()*` alone, and a quote in a URL could break a host's HTML attribute. The alphabet of the keys
// this driver writes holds nothing to encode, so their URLs stay as they were.
function encodeKeyForUrl(key: string): string {
  return key
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

// Only the presigner itself missing is the host's to install. A package missing deeper in its tree
// stays the raw error, as in importDriver, since the message would otherwise blame the wrong one.
async function importPresigner() {
  try {
    return await import('@aws-sdk/s3-request-presigner');
  } catch (cause) {
    if (missingPackageOf(cause) === '@aws-sdk/s3-request-presigner') {
      throw new ResizeSetupError(
        'resize s3: signedUrl() needs the optional peer `@aws-sdk/s3-request-presigner` — install it',
        { code: 'RESIZE_PEER_MISSING', cause },
      );
    }
    throw cause;
  }
}

export class S3Storage extends ResizeStorage {
  readonly #opts: S3StorageOptions;
  // Memoized per instance (a host may construct more than one driver). A host-provided
  // `opts.client` short-circuits construction. Synchronous now that the SDK is a static
  // import — built lazily on first I/O use.
  #client: S3Client | undefined;

  constructor(opts: S3StorageOptions) {
    super();
    // A JavaScript host would otherwise fall through silently to bucket URLs. Unset loses nothing.
    if ((opts as { publicUrl?: unknown }).publicUrl !== undefined) {
      throw new ResizeConfigError(
        'resize s3: the `publicUrl` option is removed — use `publicBaseUrl`',
        { code: 'RESIZE_CONFIG_REMOVED_KEY' },
      );
    }
    // erasableSyntaxOnly: no parameter properties — assign fields explicitly.
    this.#opts = opts;
  }

  /**
   * The storage of a config's `storage` section (driver 's3'). Only this driver's keys are read:
   * an environment file that switched the driver leaves the other driver's keys (e.g. rootDir) in
   * the merged section. A key set to `undefined` is left out, so the SDK's defaults apply. A
   * missing or empty bucketPublic, or an optional key set to something other than a string, is
   * RESIZE_CONFIG_INVALID naming `ctx.where`; '' passes as before (`publicBaseUrl: ''` means no
   * CDN base: the bucket URL), and `forcePathStyle` is passed on as given. A `publicUrl` key that
   * is set is RESIZE_CONFIG_REMOVED_KEY naming `ctx.where`, as the constructor refuses the option:
   * every other unknown key is ignored here, so it would otherwise fall through to bucket URLs.
   * Credentials come from the AWS provider chain; a host that needs its own client constructs
   * S3Storage itself.
   */
  static fromConfig(section: S3StorageConfig, ctx: DriverContext): S3Storage {
    const { where } = ctx;
    if ((section as { publicUrl?: unknown }).publicUrl !== undefined) {
      throw new ResizeConfigError(
        `resize config: \`storage.publicUrl\` in ${where} is no longer supported — use \`storage.publicBaseUrl\``,
        { code: 'RESIZE_CONFIG_REMOVED_KEY' },
      );
    }
    const bucketPublic = requiredString(
      section.bucketPublic,
      'storage.bucketPublic',
      where,
    );
    const bucketPrivate = optionalString(
      section.bucketPrivate,
      'storage.bucketPrivate',
      where,
    );
    const publicBaseUrl = optionalString(
      section.publicBaseUrl,
      'storage.publicBaseUrl',
      where,
    );
    const region = optionalString(section.region, 'storage.region', where);
    const endpoint = optionalString(
      section.endpoint,
      'storage.endpoint',
      where,
    );
    const { forcePathStyle } = section;
    return new S3Storage({
      bucketPublic,
      ...(bucketPrivate === undefined ? {} : { bucketPrivate }),
      ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
      ...(region === undefined ? {} : { region }),
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(forcePathStyle === undefined ? {} : { forcePathStyle }),
    });
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
      `resize s3: ref.bucket "${bucket}" is not an allowlisted bucket (bucketPublic/bucketPrivate) — refusing cross-bucket access`,
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
    validateStoredKey(ref.key);
    const namespace = validateNamespace(ref.namespace);
    if (namespace && !ref.key.startsWith(`${namespace}/`)) {
      throw new ResizeSecurityError('resize s3: namespace does not match key', {
        code: 'RESIZE_S3_REF_INVALID',
      });
    }
    // The raw ref, never a copy with an encoded key: its JSON form is signed into every `origin`.
    return ref as unknown as S3StorageRef;
  }

  // Upload a NEW object. Route by visibility (NO per-object ACL — public access is a
  // bucket policy). The driver owns the physical bucket; returns the ref to persist.
  // Every public object this driver uploads (previews, public raster originals, and a host's
  // own direct uploads) is cacheable for a year and immutable: every key the module writes is
  // new and random, so an object never changes under its URL. A host that calls `upload`
  // directly must give each object a new key, as the contract says. A host that deletes a public
  // object that must disappear sooner purges its CDN, which may keep serving the URL for up to a
  // year; the purge does not reach copies that browsers already hold, which they may keep until
  // they expire.
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
        ...(visibility === 'public'
          ? { CacheControl: PUBLIC_CACHE_CONTROL }
          : {}),
        ...(contentType === 'image/svg+xml'
          ? { ContentDisposition: 'attachment' }
          : {}),
      }),
    );
    return {
      bucket,
      key: physicalKey,
      ...(grouping === undefined ? {} : { namespace: grouping }),
    };
  }

  async download(
    ref: StorageRef,
    opts?: StorageDownloadOptions,
  ): Promise<Buffer> {
    const { bucket, key } = this.#ref(ref);
    let out: GetObjectCommandOutput;
    try {
      out = await this.#getClient().send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
    } catch (err) {
      // By name only: a role without s3:ListBucket gets a 403 for a missing key, which stays raw.
      if ((err as { name?: unknown } | null)?.name === 'NoSuchKey') {
        throw new ResizeStorageError(
          `resize s3: object not found: ${bucket}/${key}`,
          { code: 'RESIZE_STORAGE_NOT_FOUND', cause: err },
        );
      }
      throw err;
    }
    // From the response's own length, so no HeadObject and no new IAM permission. A response
    // without one is read, and the core checks the bytes.
    const length = out.ContentLength;
    if (
      opts?.maxBytes !== undefined &&
      length !== undefined &&
      length > opts.maxBytes
    ) {
      // The body is unread and its connection open: dropping it is what stops the transfer.
      (out.Body as { destroy?: () => void } | undefined)?.destroy?.();
      throw new ResizeMediaError(
        `resize s3: object is ${length} bytes, over the ${opts.maxBytes} byte limit (limits.sourceBytes)`,
        { code: 'RESIZE_SOURCE_TOO_LARGE', retryable: false },
      );
    }
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

  // PURE string building — no SDK, no I/O (called on the read path). Three forms:
  // explicit publicBaseUrl → CDN; endpoint/forcePathStyle → path-style; else
  // virtual-hosted.
  publicUrl(ref: StorageRef): string {
    const { bucket, key } = this.#ref(ref);
    // A ref explicitly pointing at the configured private bucket must never be turned into a
    // public CDN URL. The engine only asks for stored previews; keep the driver safe when a host
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
    const urlKey = encodeKeyForUrl(key);
    const { publicBaseUrl } = this.#opts;
    if (publicBaseUrl) {
      return `${publicBaseUrl.replace(/\/+$/, '')}/${urlKey}`;
    }
    // AWS's own host name: the China regions live under amazonaws.com.cn.
    const region = this.#opts.region ?? 'us-east-1';
    const awsHost = `s3.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`;
    if (this.#opts.endpoint !== undefined || this.#opts.forcePathStyle) {
      const base = (this.#opts.endpoint ?? `https://${awsHost}`).replace(
        /\/+$/,
        '',
      );
      return `${base}/${bucket}/${urlKey}`;
    }
    return `https://${bucket}.${awsHost}/${urlKey}`;
  }

  // Time-limited signed URL for owner/admin reads of a private original. The ref is checked before
  // the import, so a refused ref is the same refusal with or without the presigner installed.
  async signedUrl(ref: StorageRef, ttlSeconds: number): Promise<string> {
    const { bucket, key } = this.#ref(ref);
    const { getSignedUrl } = await importPresigner();
    return getSignedUrl(
      this.#getClient(),
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }
}
