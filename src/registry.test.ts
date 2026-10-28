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

test('reset() forgets every item and runs every onReset hook', () => {
  const registry = new Registry<{ name: string }>();
  const order: string[] = [];
  registry.onReset(() => {
    order.push(`first, ${registry.list().length} left`);
  });
  registry.onReset(() => {
    order.push('second');
  });
  registry.register({ name: 'a' });
  registry.reset();
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(order, ['first, 0 left', 'second']);
  // A forgotten name can be registered again.
  const again = { name: 'a' };
  registry.register(again);
  assert.equal(registry.get('a'), again);
});
