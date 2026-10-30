import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResizeSetupError } from './errors.ts';
import { Registry } from './registry.ts';

test("register() keeps items by name; get() finds them, by default 'default'", () => {
  const registry = new Registry<{ name: string }>();
  const first = { name: 'default' };
  const listings = { name: 'listings' };
  registry.register(first);
  registry.register(listings);
  assert.equal(registry.get(), first);
  assert.equal(registry.get('default'), first);
  assert.equal(registry.get('listings'), listings);
});

test('a duplicate name is RESIZE_DUPLICATE_RESIZER and keeps the first item', () => {
  const registry = new Registry<{ name: string }>();
  const first = { name: 'listings' };
  registry.register(first);
  assert.throws(
    () => registry.register({ name: 'listings' }),
    (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_DUPLICATE_RESIZER' &&
      err.message.includes("'listings'"),
  );
  assert.equal(registry.get('listings'), first);
});

test('a missing name is RESIZE_NO_RESIZER and names it', () => {
  const registry = new Registry<{ name: string }>();
  registry.register({ name: 'listings' });
  assert.throws(
    () => registry.get(),
    (err: unknown) =>
      err instanceof ResizeSetupError &&
      err.code === 'RESIZE_NO_RESIZER' &&
      err.message.includes("'default'"),
  );
});

test('list() returns every item in registration order', () => {
  const registry = new Registry<{ name: string }>();
  const a = { name: 'a' };
  const b = { name: 'b' };
  registry.register(a);
  registry.register(b);
  const listed = registry.list();
  assert.deepEqual(listed, [a, b]);
  listed.pop(); // a copy: changing it does not change the registry
  assert.deepEqual(registry.list(), [a, b]);
});

test('shared() builds once per key and hands every caller the same promise', async () => {
  const registry = new Registry<{ name: string }>();
  let builds = 0;
  const part = {};
  const build = async () => {
    builds += 1;
    return part;
  };
  const first = registry.shared('k', build);
  const second = registry.shared('k', build);
  assert.equal(first, second);
  assert.equal(await first, part);
  assert.equal(await second, part);
  assert.equal(builds, 1);
});

test('a rejected shared build is forgotten, so the next call builds again', async () => {
  const registry = new Registry<{ name: string }>();
  let builds = 0;
  const build = async () => {
    builds += 1;
    if (builds === 1) {
      throw new Error('the first build fails');
    }
    return builds;
  };
  await assert.rejects(registry.shared('k', build), /the first build fails/);
  assert.equal(await registry.shared('k', build), 2);
  assert.equal(await registry.shared('k', build), 2);
  assert.equal(builds, 2);
});

test('reset() forgets every item and shared part', async () => {
  const registry = new Registry<{ name: string }>();
  let builds = 0;
  const build = async () => {
    builds += 1;
    return builds;
  };
  registry.register({ name: 'a' });
  assert.equal(await registry.shared('k', build), 1);
  registry.reset();
  assert.deepEqual(registry.list(), []);
  assert.equal(await registry.shared('k', build), 2);
  // A forgotten name can be registered again.
  const again = { name: 'a' };
  registry.register(again);
  assert.equal(registry.get('a'), again);
});

test('sharedValue() records the first value per key and returns it; recordedValue() reads it without recording; reset() forgets it', () => {
  const registry = new Registry<{ name: string }>();
  const first = { kind: 'first' };
  const second = { kind: 'second' };
  assert.equal(registry.recordedValue('k'), undefined);
  assert.equal(registry.sharedValue('k', first), first);
  assert.equal(registry.recordedValue('k'), first);
  assert.equal(registry.sharedValue('k', second), first);
  assert.equal(registry.sharedValue('other', second), second);
  registry.reset();
  assert.equal(registry.sharedValue('k', second), second);
});
