import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ResizeConfigError,
  ResizeError,
  ResizeGenerateError,
  ResizeMediaError,
  ResizeNoOriginalError,
  ResizeSecurityError,
  ResizeSetupError,
  ResizeStorageError,
} from './errors.ts';

// The six subclasses that take the plain (message, opts) shape.
const SIMPLE_SUBCLASSES = [
  { Ctor: ResizeSetupError, name: 'ResizeSetupError', code: 'RESIZE_SETUP' },
  { Ctor: ResizeConfigError, name: 'ResizeConfigError', code: 'RESIZE_CONFIG' },
  {
    Ctor: ResizeStorageError,
    name: 'ResizeStorageError',
    code: 'RESIZE_STORAGE',
  },
  {
    Ctor: ResizeSecurityError,
    name: 'ResizeSecurityError',
    code: 'RESIZE_SECURITY',
  },
  { Ctor: ResizeMediaError, name: 'ResizeMediaError', code: 'RESIZE_MEDIA' },
] as const;

describe('ResizeError (base)', () => {
  test('is an Error with a defaulted code', () => {
    const err = new ResizeError('boom');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof ResizeError);
    assert.equal(err.name, 'ResizeError');
    assert.equal(err.code, 'RESIZE_ERROR');
    assert.equal(err.message, 'boom');
  });

  test('accepts an explicit code and propagates `cause`', () => {
    const root = new Error('root');
    const err = new ResizeError('wrapped', { code: 'X_Y', cause: root });
    assert.equal(err.code, 'X_Y');
    assert.equal(err.cause, root);
  });

  test('defines NO own `cause` property when none was supplied', () => {
    // `{ cause: undefined }` would define the property, which serializes differently.
    assert.equal('cause' in new ResizeError('no cause'), false);
  });

  test('the brand symbol never leaks into JSON or Object.keys', () => {
    const json = JSON.stringify(new ResizeError('x'));
    assert.ok(!json.includes('framework-module-resize.error'));
    assert.ok(!json.includes('stack')); // message/stack stay non-enumerable
  });
});

describe('ResizeError.isResizeError', () => {
  test('is true for every subclass and false for a plain Error', () => {
    assert.ok(ResizeError.isResizeError(new ResizeError('a')));
    assert.ok(ResizeError.isResizeError(new ResizeNoOriginalError('m')));
    assert.ok(!ResizeError.isResizeError(new Error('plain')));
    assert.ok(!ResizeError.isResizeError(null));
    assert.ok(!ResizeError.isResizeError('a string'));
  });

  test('survives the duplicate-package case where `instanceof` fails', () => {
    // Two copies of this package in one node_modules tree produce two class identities, so
    // `instanceof` returns false for an error thrown by the other copy. The brand does not.
    const brand = Symbol.for('@adaptivestone/framework-module-resize.error');
    const fromOtherCopy = Object.create(Error.prototype) as Record<
      symbol,
      unknown
    >;
    fromOtherCopy[brand] = true;

    assert.equal(fromOtherCopy instanceof ResizeError, false);
    assert.ok(ResizeError.isResizeError(fromOtherCopy));
  });
});

describe('subclasses', () => {
  for (const { Ctor, name, code } of SIMPLE_SUBCLASSES) {
    test(`${name} extends ResizeError, names itself, and defaults its code`, () => {
      const err = new Ctor('msg');
      assert.ok(err instanceof Error);
      assert.ok(err instanceof ResizeError);
      assert.ok(err instanceof Ctor);
      assert.equal(err.name, name);
      assert.equal(err.code, code);
      assert.equal(err.message, 'msg');
    });

    test(`${name} accepts a call-site code override`, () => {
      assert.equal(new Ctor('msg', { code: 'SPECIFIC' }).code, 'SPECIFIC');
    });
  }
});

describe('ResizeMediaError', () => {
  test('carries an optional mediaId', () => {
    assert.equal(new ResizeMediaError('m').mediaId, undefined);
    assert.equal(new ResizeMediaError('m', { mediaId: 'x1' }).mediaId, 'x1');
  });
});

describe('ResizeNoOriginalError', () => {
  test('is instanceof Error with a stable name and the media id', () => {
    const err = new ResizeNoOriginalError('m1');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof ResizeNoOriginalError);
    assert.equal(err.name, 'ResizeNoOriginalError');
    assert.equal(err.mediaId, 'm1');
    assert.match(err.message, /m1/);
    assert.match(err.message, /no original/);
  });

  test('is catchable as ResizeMediaError and as ResizeError', () => {
    const err = new ResizeNoOriginalError('m1');
    assert.ok(err instanceof ResizeMediaError);
    assert.ok(err instanceof ResizeError);
    assert.equal(err.code, 'RESIZE_NO_ORIGINAL');
  });
});

describe('ResizeGenerateError', () => {
  test('is instanceof Error and carries failed/requested counts', () => {
    const err = new ResizeGenerateError({
      mediaId: 'm2',
      failed: 3,
      requested: 3,
    });
    assert.ok(err instanceof ResizeGenerateError);
    assert.equal(err.name, 'ResizeGenerateError');
    assert.equal(err.mediaId, 'm2');
    assert.equal(err.failed, 3);
    assert.equal(err.requested, 3);
    assert.match(err.message, /0 previews/);
    assert.match(err.message, /3/);
  });

  test('extends ResizeError with a default code', () => {
    const err = new ResizeGenerateError({
      mediaId: 'm2',
      failed: 1,
      requested: 1,
    });
    assert.ok(err instanceof ResizeError);
    assert.equal(err.code, 'RESIZE_GENERATE_FAILED');
  });

  test('the worker may override message + code (retry/dead-letter wording)', () => {
    // The queued worker hits the same condition but needs its own operational wording.
    const err = new ResizeGenerateError({
      mediaId: 'm3',
      failed: 2,
      requested: 4,
      message: 'resize worker: … failing for retry/dead-letter',
      code: 'RESIZE_WORKER_ALL_VARIANTS_FAILED',
    });
    assert.match(err.message, /failing for retry\/dead-letter/);
    assert.equal(err.code, 'RESIZE_WORKER_ALL_VARIANTS_FAILED');
    assert.equal(err.requested, 4);
    assert.ok(err instanceof ResizeGenerateError);
  });
});
