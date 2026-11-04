// The gateway to the framework's ambient app singleton. Only the framework adapter
// (`src/framework/`) and the framework-backed drivers import it; the package's main entry
// never does, so the core runs without @adaptivestone/framework.
import type { EventEmitter } from 'node:events';
import { appInstance } from '@adaptivestone/framework/helpers/appInstance.js';
import type { ResizeMetrics } from '../contracts/metrics.ts';
import { ResizeSetupError } from '../errors.ts';
import type { ResizeEventBus, ResizeLogger } from '../types.d.ts';

/** The slice of the framework app the adapter and the framework drivers use. */
export type TMinimalResizeApp = {
  getConfig(name: string): unknown;
  // Returns a Mongoose model registered by the host, or a falsy value for an unknown name.
  // biome-ignore lint/suspicious/noExplicitAny: mongoose model statics are host-defined
  getModel(name: string): any;
  logger: ResizeLogger;
  events?: ResizeEventBus;
  foldersConfig?: { [k: string]: string | undefined };
};

/**
 * The framework app, set once per process at Server construction (the framework
 * enforces one server per process). Throws a clear error when called before the
 * Server exists. Tests install a fake via setAppInstance()/resetAppInstance()
 * from '@adaptivestone/framework/helpers/appInstance.js'.
 */
export function getApp(): TMinimalResizeApp {
  if (!appInstance) {
    throw new ResizeSetupError(
      'resize: framework app is not initialized yet — construct the Server before calling resize APIs (tests: setAppInstance from @adaptivestone/framework/helpers/appInstance.js)',
      { code: 'RESIZE_APP_NOT_INITIALIZED' },
    );
  }
  return appInstance as unknown as TMinimalResizeApp;
}

/**
 * A logger that resolves the app logger at call time, so a driver built before the app exists
 * (or across a test's fake-app swap) still logs through the current app.
 */
export const appLogger: ResizeLogger = {
  info: (msg, ...rest) => getApp().logger.info(msg, ...rest),
  warn: (msg, ...rest) => getApp().logger.warn(msg, ...rest),
  error: (msg, ...rest) => getApp().logger.error(msg, ...rest),
  // Always present, so a `new LogMetrics(logger, { debug: true })` on this logger can write debug
  // lines; an app logger without a debug function drops them.
  debug: (msg: string, ...rest: unknown[]) => {
    const { logger } = getApp();
    if (typeof logger.debug === 'function') {
      logger.debug(msg, ...rest);
    }
  },
};

/** An event bus that resolves the app's bus at emit time (a missing bus drops the event). */
export const appEvents: ResizeEventBus = {
  emit: (name, ...args) => getApp().events?.emit(name, ...args),
};

// Keyed by the app's event bus, so it cannot outlive it. One listener per bus, whatever the number
// of sinks: more than ten listeners print MaxListenersExceededWarning.
const flushing = new WeakMap<object, Set<ResizeMetrics>>();

/** Write the sink's open window on the framework's `shutdown`, before its logger closes. */
export function flushAtShutdown(sink: ResizeMetrics): void {
  const events = getApp().events as Partial<EventEmitter> | undefined;
  if (typeof events?.prependOnceListener !== 'function') {
    return;
  }
  const known = flushing.get(events);
  if (known) {
    known.add(sink);
    return;
  }
  const sinks = new Set([sink]);
  flushing.set(events, sinks);
  // First in line: the framework's logger closes on the same event, and drops any line after that.
  events.prependOnceListener('shutdown', () => {
    flushing.delete(events);
    for (const each of sinks) {
      try {
        void Promise.resolve(each.flush?.()).catch(() => {});
      } catch {
        // A host's sink must not break the host's shutdown.
      }
    }
  });
}
