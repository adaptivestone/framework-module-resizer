import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pipeline } from './contracts/pipeline.ts';
import { PipelineRegistry } from './pipelines.ts';

test('a seeded pipeline is returned by get()', () => {
  const photo: Pipeline = { beforeSteps: [] };
  const pipelines = new PipelineRegistry({ photo });
  assert.equal(pipelines.get('photo'), photo);
});

test('an unknown name returns one frozen empty pipeline', () => {
  const pipelines = new PipelineRegistry();
  const empty = pipelines.get('a');
  assert.deepEqual(empty, {});
  assert.equal(Object.isFrozen(empty), true);
  assert.equal(pipelines.get('a'), pipelines.get('b'));
});

test("has() is true for 'default' and seeded names only", () => {
  const pipelines = new PipelineRegistry({ photo: { variantSteps: [] } });
  assert.equal(pipelines.has('default'), true);
  assert.equal(pipelines.has('photo'), true);
  assert.equal(pipelines.has('video'), false);
  assert.equal(new PipelineRegistry().has('default'), true);
});
