// The ONE gateway to the framework's ambient app singleton (the only other file
// that imports the framework is src/models/ResizeTask.ts, for BaseModel — 01 · §2.3).
// Everything else in the module calls getApp(), so the framework import surface
// stays at exactly two files and every call site gets one clear failure mode.
import { appInstance } from '@adaptivestone/framework/helpers/appInstance.js';
import { ResizeSetupError } from './errors.ts';
import type { TMinimalResizeApp } from './types.d.ts';

/**
 * The framework app, set once per process at Server construction (the framework
 * enforces one server per process). Throws a clear error when called before the
 * Server exists. Tests install a fake via setAppInstance()/resetAppInstance()
 * from '@adaptivestone/framework/helpers/appInstance.js' (per-file isolation —
 * node:test runs each test file in its own process).
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
