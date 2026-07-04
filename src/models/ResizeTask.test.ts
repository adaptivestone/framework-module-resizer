import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BaseModel } from '@adaptivestone/framework/modules/BaseModel.js';
import mongoose from 'mongoose';
import ResizeTaskModel from './ResizeTask.ts';

// Tests MAY import mongoose (a devDep): the no-mongoose rule (01 · §16) is for the
// module's RUNTIME code only. Building a real mongoose.Schema is how we exercise the
// string type aliases + initHooks against the same engine the framework uses at runtime.

describe('ResizeTaskModel — literal extends (loader + codegen requirement)', () => {
  test('is a literal `class … extends BaseModel` (runtime instanceof check)', () => {
    // The framework loader registers the model only if `prototype instanceof BaseModel`
    // holds (server.ts). Importing the same BaseModel copy mirrors that check here.
    assert.equal(ResizeTaskModel.prototype instanceof BaseModel, true);
  });
});

describe('ResizeTaskModel.modelSchema — spec/08 §12 fields', () => {
  test('fileId is an ObjectId ref (this.fileRef), required', () => {
    const s = ResizeTaskModel.modelSchema;
    assert.equal(s.fileId.type, 'ObjectId');
    assert.equal(s.fileId.ref, 'File');
    assert.equal(s.fileId.required, true);
  });

  test('static fileRef defaults to File and drives fileId.ref', () => {
    assert.equal(ResizeTaskModel.fileRef, 'File');
    assert.equal(ResizeTaskModel.modelSchema.fileId.ref, 'File');
  });

  test('a subclass overriding static fileRef changes ref via this.fileRef (deep-review #7)', () => {
    class HostResizeTask extends ResizeTaskModel {
      static fileRef = 'Media';
    }
    assert.equal(HostResizeTask.modelSchema.fileId.ref, 'Media');
    // The base class is unaffected (the getter reads `this`, not a captured constant).
    assert.equal(ResizeTaskModel.modelSchema.fileId.ref, 'File');
  });

  test('pipeline is a String defaulting to "default"', () => {
    const p = ResizeTaskModel.modelSchema.pipeline;
    assert.equal(p.type, String);
    assert.equal(p.default, 'default');
  });

  test('status is the four-state enum defaulting to "pending"', () => {
    const st = ResizeTaskModel.modelSchema.status;
    assert.deepEqual(
      [...st.enum],
      ['pending', 'processing', 'completed', 'dead'],
    );
    assert.equal(st.default, 'pending');
  });

  test('attempts is a Number defaulting to 0', () => {
    const a = ResizeTaskModel.modelSchema.attempts;
    assert.equal(a.type, Number);
    assert.equal(a.default, 0);
  });

  test('previews carries the requested-variant shape with a format enum', () => {
    const item = ResizeTaskModel.modelSchema.previews[0];
    assert.equal(item.sizeKey.type, String);
    assert.ok('filters' in item);
    assert.ok('requestedWidth' in item);
    assert.ok('requestedHeight' in item);
    assert.ok('fit' in item);
    assert.deepEqual([...item.format.enum], ['jpeg', 'webp', 'avif']);
  });

  test('lease / timestamp / error fields are present', () => {
    const s = ResizeTaskModel.modelSchema;
    for (const k of [
      'leasedBy',
      'leaseToken',
      'leaseExpiresAt',
      'completedAt',
      'deadAt',
      'error',
    ]) {
      assert.ok(k in s, `missing field ${k}`);
    }
  });
});

describe('ResizeTaskModel.initHooks — the five indexes (spec/08 §12)', () => {
  // Build a real schema from modelSchema (string aliases resolve at runtime) and let
  // initHooks add its indexes, then assert the exact fields + options.
  const buildIndexes = () => {
    const schema = new mongoose.Schema(ResizeTaskModel.modelSchema);
    ResizeTaskModel.initHooks(schema);
    return schema.indexes();
  };
  const byFields = (
    indexes: ReturnType<mongoose.Schema['indexes']>,
    fields: Record<string, number>,
  ) => indexes.find(([f]) => JSON.stringify(f) === JSON.stringify(fields));

  test('adds exactly five indexes', () => {
    assert.equal(buildIndexes().length, 5);
  });

  test('completedAt TTL 86400 partial to status:completed', () => {
    const idx = byFields(buildIndexes(), { completedAt: 1 });
    assert.ok(idx);
    assert.deepEqual(idx[1], {
      expireAfterSeconds: 86400,
      partialFilterExpression: { status: 'completed' },
    });
  });

  test('deadAt TTL 2592000 partial to status:dead', () => {
    const idx = byFields(buildIndexes(), { deadAt: 1 });
    assert.ok(idx);
    assert.deepEqual(idx[1], {
      expireAfterSeconds: 2592000,
      partialFilterExpression: { status: 'dead' },
    });
  });

  test('{ status:1, createdAt:1 } with no options (lease hot path)', () => {
    const idx = byFields(buildIndexes(), { status: 1, createdAt: 1 });
    assert.ok(idx);
    assert.deepEqual(idx[1], {});
  });

  test('{ leaseExpiresAt:1 } partial to status:processing, NOT sparse', () => {
    const idx = byFields(buildIndexes(), { leaseExpiresAt: 1 });
    assert.ok(idx);
    assert.deepEqual(idx[1], {
      partialFilterExpression: { status: 'processing' },
    });
    // NOT sparse: a null leaseExpiresAt would not be excluded by a sparse index.
    assert.equal('sparse' in idx[1], false);
  });

  test('{ fileId:1, createdAt:-1 } with no options', () => {
    const idx = byFields(buildIndexes(), { fileId: 1, createdAt: -1 });
    assert.ok(idx);
    assert.deepEqual(idx[1], {});
  });
});

describe('ResizeTaskModel — §16 no-mongoose invariant', () => {
  test('the module source never imports mongoose', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./ResizeTask.ts', import.meta.url)),
      'utf8',
    );
    assert.doesNotMatch(src, /from ['"]mongoose['"]/);
  });
});

describe('ResizeTaskModel — full initialize() round-trip', () => {
  // A live initialize() + lease-shaped findOneAndUpdate smoke test needs
  // mongodb-memory-server (first run downloads a mongod binary) and more app wiring
  // than is reasonable at the model layer. Step 7's mongo-transport tests cover live
  // lease/complete/fail behavior against a real DB, so this is intentionally skipped.
  test('lease round-trip against a live DB', {
    skip: 'covered by step 7',
  }, () => {});
});
