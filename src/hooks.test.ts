import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HookBus } from './hooks.ts';
import type { ResizeEventBus, ResizeLogger } from './types.d.ts';

// A recording logger (logger.error pushes to `errors`) and event bus (emit pushes to `emitted`,
// or throws when emitThrows).
function recorder(opts: { emitThrows?: boolean } = {}): {
  errors: unknown[][];
  emitted: unknown[][];
  logger: ResizeLogger;
  events: ResizeEventBus;
} {
  const errors: unknown[][] = [];
  const emitted: unknown[][] = [];
  const logger: ResizeLogger = {
    info() {},
    warn() {},
    error(...args: unknown[]) {
      errors.push(args);
    },
  };
  const events: ResizeEventBus = {
    emit(name: string, ...args: unknown[]) {
      if (opts.emitThrows) {
        throw new Error('emit boom');
      }
      emitted.push([name, ...args]);
    },
  };
  return { errors, emitted, logger, events };
}

describe('taps', () => {
  test('taps seeded as a function or an array run in order, and add() appends', async () => {
    const { logger } = recorder();
    const calls: string[] = [];
    const tap = (label: string) => (value: unknown) => {
      calls.push(label);
      return value;
    };
    const seeded = [tap('a'), tap('b')];
    const bus = new HookBus({
      logger,
      taps: { resolveSizes: seeded, beforeEnqueue: tap('single') },
    });
    // The seeded array is copied: changing it later does not add a tap.
    seeded.push(tap('late'));
    bus.add('resolveSizes', tap('c'));
    await bus.runWaterfall('resolveSizes', [], {});
    assert.deepEqual(calls, ['a', 'b', 'c']);
    await bus.runWaterfall('beforeEnqueue', [], {});
    assert.deepEqual(calls, ['a', 'b', 'c', 'single']);
  });

  test("'optional' mode returns undefined with no taps or when every tap throws", async () => {
    const { logger } = recorder();
    const bus = new HookBus({ logger });
    const value = { a: 1 };
    assert.equal(
      await bus.runWaterfall('formatPublicUrls', value, {}, 'optional'),
      undefined,
    );
    bus.add('formatPublicUrls', () => {
      throw new Error('boom');
    });
    assert.equal(
      await bus.runWaterfall('formatPublicUrls', value, {}, 'optional'),
      undefined,
    );
    bus.add('formatPublicUrls', () => 'dto');
    assert.equal(
      await bus.runWaterfall('formatPublicUrls', value, {}, 'optional'),
      'dto',
    );
  });
});

describe('runWaterfall', () => {
  test('threads the value through taps in registration order', async () => {
    const { logger, events } = recorder();
    const bus = new HookBus({ logger, events });
    bus.add('resolveSizes', (v: number) => v + 1);
    bus.add('resolveSizes', async (v: number) => v * 2);
    const out = await bus.runWaterfall('resolveSizes', 1, {});
    assert.equal(out, 4); // (1 + 1) * 2
  });

  test('threads ctx to each tap', async () => {
    const { logger, events } = recorder();
    const bus = new HookBus({ logger, events });
    const ctx = { entity: 'event' };
    let seen: unknown;
    bus.add('beforeEnqueue', (v: unknown, c: unknown) => {
      seen = c;
      return v;
    });
    await bus.runWaterfall('beforeEnqueue', [], ctx);
    assert.equal(seen, ctx);
  });

  test('a throwing tap is logged and skipped (prior value kept); later taps still run', async () => {
    const { errors, logger, events } = recorder();
    const bus = new HookBus({ logger, events });
    bus.add('resolveSizes', (v: number) => v + 1);
    bus.add('resolveSizes', () => {
      throw new Error('boom');
    });
    bus.add('resolveSizes', (v: number) => v + 10);
    const out = await bus.runWaterfall('resolveSizes', 0, {});
    assert.equal(out, 11); // 0+1 → (throw → keep 1) → 1+10
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /resolveSizes/);
  });

  test('with no taps returns the input unchanged', async () => {
    const { logger, events } = recorder();
    const bus = new HookBus({ logger, events });
    const value = { a: 1 };
    assert.equal(await bus.runWaterfall('formatPublicUrls', value, {}), value);
  });
});

describe('runObservers', () => {
  test('awaits every tap in registration order', async () => {
    const { logger, events } = recorder();
    const bus = new HookBus({ logger, events });
    const order: number[] = [];
    bus.add('afterTaskComplete', async () => {
      await Promise.resolve();
      order.push(1);
    });
    bus.add('afterTaskComplete', () => {
      order.push(2);
    });
    await bus.runObservers('afterTaskComplete', {}, {});
    assert.deepEqual(order, [1, 2]);
  });

  test('a throwing tap is logged and does not stop later taps', async () => {
    const { errors, logger, events } = recorder();
    const bus = new HookBus({ logger, events });
    const seen: string[] = [];
    bus.add('onTaskFailed', () => {
      throw new Error('boom');
    });
    bus.add('onTaskFailed', () => {
      seen.push('second');
    });
    await bus.runObservers('onTaskFailed', {}, new Error('x'), {});
    assert.deepEqual(seen, ['second']);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /onTaskFailed/);
  });

  test('mirrors onto the event bus as resize:<name> BEFORE the taps run', async () => {
    const { emitted, logger, events } = recorder();
    const bus = new HookBus({ logger, events });
    let emittedLenWhenTapRan = -1;
    bus.add('onPreviewGenerated', () => {
      emittedLenWhenTapRan = emitted.length;
    });
    await bus.runObservers('onPreviewGenerated', 'preview-arg', {});
    assert.equal(emittedLenWhenTapRan, 1); // the emit already happened before the tap
    assert.deepEqual(emitted[0], [
      'resize:onPreviewGenerated',
      'preview-arg',
      {},
    ]);
  });

  test('a missing event bus is fine — taps still run', async () => {
    const { logger } = recorder();
    const bus = new HookBus({ logger }); // no events
    const seen: string[] = [];
    bus.add('afterTaskComplete', () => {
      seen.push('ran');
    });
    await bus.runObservers('afterTaskComplete', {}, {});
    assert.deepEqual(seen, ['ran']);
  });

  test('a THROWING events.emit is caught (logged) and taps still run', async () => {
    const { errors, logger, events } = recorder({ emitThrows: true });
    const bus = new HookBus({ logger, events });
    const seen: string[] = [];
    bus.add('onTaskDeadLettered', () => {
      seen.push('ran');
    });
    await bus.runObservers('onTaskDeadLettered', {}, new Error('x'), {});
    assert.deepEqual(seen, ['ran']);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /onTaskDeadLettered/);
  });
});
