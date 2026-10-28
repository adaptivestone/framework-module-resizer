// Core files read nothing process-wide (getApp, getResizeConfig, getResizer, listResizers): each
// gets what it needs from its caller. Only the entry points (index.ts, worker.ts) and the
// framework adapter import resizer.ts (pinned in importGraph.test.ts). Core is every top-level
// src/ file except worker.ts (an entry point that looks Resizers up by name), registry.ts (the
// generic registry class; the process-wide instance lives in resizer.ts), index.ts (the main
// entry) and types.d.ts (types only).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { sourceFiles } from './testHelpers/imports.ts';

const CORE_FILES = sourceFiles().filter(
  (f) =>
    !f.includes('/') &&
    !['worker.ts', 'registry.ts', 'index.ts', 'types.d.ts'].includes(f),
);
const GLOBAL_LOOKUPS = new Set([
  'getApp',
  'getResizeConfig',
  'getResizer',
  'listResizers',
]);

/** The source of `f`, a path relative to src/. */
const read = (f: string): string =>
  readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');

/** Names imported as runtime values (`import type` and `type X` specifiers are erased). */
function valueImports(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(
    /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'[^']+'/g,
  )) {
    if (match[1]) {
      continue;
    }
    for (const part of match[2].split(',')) {
      const specifier = part.trim();
      if (specifier && !specifier.startsWith('type ')) {
        names.push(specifier.split(/\s+as\s+/)[0]);
      }
    }
  }
  return names;
}

test('the core list sees the services', () => {
  assert.ok(
    CORE_FILES.includes('processor.ts') && CORE_FILES.includes('resizer.ts'),
    'sanity check: the listing does see the top-level files',
  );
});

for (const file of CORE_FILES) {
  test(`${file} imports no process-wide lookup`, async () => {
    const source = await readFile(
      new URL(`./${file}`, import.meta.url),
      'utf8',
    );
    const found = valueImports(source).filter((name) =>
      GLOBAL_LOOKUPS.has(name),
    );
    assert.deepEqual(
      found,
      [],
      `${file} must take what it needs from its caller; only entry points look up process-wide state`,
    );
  });
}

// Which stored rows count is one rule, kept in images.ts: callers use storedPreviews /
// storedIdentities. isUsablePreview is not exported; this text check is a second net should the
// export come back.
test('only images.ts decides which stored rows count', () => {
  const users = sourceFiles().filter(
    (f) => f !== 'images.ts' && read(f).includes('isUsablePreview('),
  );
  assert.deepEqual(users, []);
});

// The host's logger is host code and may throw; the worker loop must survive that, so it logs only
// through logNeverThrow, which falls back to the console. Optional calls (`logger?.error(`) and
// references (`logger.error.bind`) count as direct too.
test('the worker loop logs only through logNeverThrow', () => {
  const direct = ['consumer.ts', 'worker.ts'].filter((f) =>
    /\blogger\??\.(info|warn|error)\b/.test(read(f)),
  );
  assert.deepEqual(direct, []);
  // The pattern itself: each of these forms is caught.
  for (const call of [
    'logger.error(',
    'logger?.warn(',
    'this.#deps.logger.info(',
    'logger.error.bind(',
  ]) {
    assert.match(call, /\blogger\??\.(info|warn|error)\b/, call);
  }
});

// One gate per Resizer, media and pipeline replaced the per-identity dispatch and worker locks:
// the gate, the queue's lease and the media store's one row per identity deduplicate the work.
test('per-identity locks are gone: no source builds a dispatch or worker lock', () =>
  assert.deepEqual(
    sourceFiles().filter((f) =>
      /resize_dispatch|resize_worker|DISPATCH_LOCK_OWNER|dispatchLockKey|workerLockKey/.test(
        read(f),
      ),
    ),
    [],
  ));

// The core owns the lock settings: the Resizer validates its coordination (coordination.ts), and
// the core's timing check rejects the removed lockTtlMs key. A driver never reads or checks them.
test('lock settings are validated only in the core', () => {
  assert.deepEqual(
    sourceFiles().filter(
      (f) => f.startsWith('drivers/') && /lockTtlMs|gateTtlMs/.test(read(f)),
    ),
    [],
  );
  assert.deepEqual(
    sourceFiles().filter(
      (f) =>
        f !== 'coordination.ts' &&
        /RESIZE_CONFIG_COORDINATION_INVALID/.test(read(f)),
    ),
    [],
  );
});
