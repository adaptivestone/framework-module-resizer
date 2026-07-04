import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  resetAppInstance,
  setAppInstance,
} from '@adaptivestone/framework/helpers/appInstance.js';
import { getApp } from './app.ts';

const fakeApp = {
  getConfig: () => ({}),
  getModel: () => ({}),
  logger: { info() {}, warn() {}, error() {} },
};

describe('getApp', () => {
  afterEach(() => {
    resetAppInstance();
  });

  test('throws a clear error before the Server exists', () => {
    resetAppInstance();
    assert.throws(() => getApp(), /not initialized/);
  });

  test('returns the ambient instance once set', () => {
    setAppInstance(fakeApp as never);
    assert.equal(getApp(), fakeApp as never);
  });
});
