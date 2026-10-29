// DecoderSet tests: fake decoders (plain objects that count their `inspect` calls) for the choice
// of a decoder, and the built-in decoders for createDecoderSet's order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Raster, SourceDecoder, SourceInfo } from './contracts/decoder.ts';
import { createDecoderSet, DecoderSet } from './decoderSet.ts';
import { ResizeError, ResizeMediaError, ResizeSetupError } from './errors.ts';
import { makeImageConfig } from './testHelpers/resizeConfig.ts';

const limits = makeImageConfig().limits;
const bytes = Buffer.from('bytes');

interface FakeDecoder extends SourceDecoder {
  calls: number;
}

type Behaviour = 'accept' | 'refuse' | Error | Partial<SourceInfo>;

/** A decoder listing `formats` whose inspect accepts, refuses, rejects with an error or returns `info`. */
function fake(formats: string[], behaviour: Behaviour): FakeDecoder {
  const decoder: FakeDecoder = {
    formats,
    calls: 0,
    async inspect(): Promise<SourceInfo> {
      decoder.calls += 1;
      if (behaviour === 'refuse') {
        throw new ResizeMediaError(`not ${formats.join('/')}`, {
          code: 'RESIZE_SOURCE_FORMAT_UNSUPPORTED',
          retryable: false,
        });
      }
      if (behaviour instanceof Error) {
        throw behaviour;
      }
      const base: SourceInfo = {
        format: formats[0],
        contentType: `image/${formats[0]}`,
        width: 10,
        height: 10,
      };
      return behaviour === 'accept' ? base : { ...base, ...behaviour };
    },
    async render(): Promise<Raster> {
      throw new Error('render is not part of these tests');
    },
  };
  return decoder;
}

test('identify asks the decoders in order and uses the first that accepts', async () => {
  const first = fake(['png'], 'refuse');
  const second = fake(['webp'], 'accept');
  const third = fake(['gif'], 'accept');
  const result = await new DecoderSet([first, second, third]).identify(
    bytes,
    limits,
  );
  assert.equal(result.decoder, second);
  assert.deepEqual(result.info, {
    format: 'webp',
    contentType: 'image/webp',
    width: 10,
    height: 10,
  });
  assert.equal(result.mismatch, undefined);
  assert.deepEqual([first.calls, second.calls, third.calls], [1, 1, 0]);
});

test('a RESIZE_SOURCE_FORMAT_UNSUPPORTED refusal moves on; any other rejection is final', async () => {
  const third = fake(['gif'], 'accept');
  await assert.rejects(
    new DecoderSet([
      fake(['png'], 'refuse'),
      fake(['webp'], new Error('boom')),
      third,
    ]).identify(bytes, limits),
    /boom/,
  );
  assert.equal(third.calls, 0);
});

test('when every decoder refuses, identify rejects with RESIZE_SOURCE_FORMAT_UNSUPPORTED naming the formats tried', async () => {
  const first = fake(['png', 'apng'], 'refuse');
  const second = fake(['webp'], 'refuse');
  await assert.rejects(
    new DecoderSet([first, second]).identify(bytes, limits),
    (err) => {
      assert.ok(ResizeError.isResizeError(err));
      assert.equal(err.code, 'RESIZE_SOURCE_FORMAT_UNSUPPORTED');
      assert.equal(err.retryable, false);
      for (const format of ['png', 'apng', 'webp']) {
        assert.ok(
          err.message.includes(format),
          `${err.message} names ${format}`,
        );
      }
      const cause = err.cause as ResizeError;
      assert.ok(ResizeError.isResizeError(cause));
      assert.equal(cause.message, 'not png/apng');
      return true;
    },
  );
});

test('a stored format picks its decoder first, without asking the others', async () => {
  const other = fake(['png'], 'accept');
  const svg = fake(['svg'], 'accept');
  const result = await new DecoderSet([other, svg]).identify(
    bytes,
    limits,
    'svg',
  );
  assert.equal(result.decoder, svg);
  assert.equal(result.mismatch, undefined);
  assert.equal(other.calls, 0);
});

test('a stored format whose decoder reads the bytes as another of its formats reports the mismatch', async () => {
  const raster = fake(['png', 'jpeg'], { format: 'jpeg' });
  const other = fake(['gif'], 'accept');
  const result = await new DecoderSet([raster, other]).identify(
    bytes,
    limits,
    'png',
  );
  assert.equal(result.decoder, raster);
  assert.equal(result.info.format, 'jpeg');
  assert.deepEqual(result.mismatch, { stored: 'png', reason: 'other-format' });
  assert.equal(other.calls, 0);
});

test('a stored format no decoder lists falls back to the probe and reports the mismatch', async () => {
  const second = fake(['jpeg'], 'accept');
  const result = await new DecoderSet([
    fake(['png'], 'refuse'),
    second,
  ]).identify(bytes, limits, 'jpg');
  assert.equal(result.decoder, second);
  assert.deepEqual(result.mismatch, { stored: 'jpg', reason: 'unlisted' });
});

test("a refusal from the stored format's decoder falls back to the probe, without asking it again", async () => {
  const png = fake(['png'], 'refuse');
  const svg = fake(['svg'], 'accept');
  const result = await new DecoderSet([png, svg]).identify(
    bytes,
    limits,
    'png',
  );
  assert.equal(result.decoder, svg);
  assert.deepEqual(result.mismatch, { stored: 'png', reason: 'refused' });
  assert.equal(png.calls, 1);
});

test("any other rejection from the stored format's decoder is final", async () => {
  const other = fake(['jpeg'], 'accept');
  await assert.rejects(
    new DecoderSet([other, fake(['png'], new Error('boom'))]).identify(
      bytes,
      limits,
      'png',
    ),
    /boom/,
  );
  assert.equal(other.calls, 0);
});

test('when the probe finds nothing: RESIZE_DECODER_MISSING for an unlisted format, else the probe error', async () => {
  await assert.rejects(
    new DecoderSet([fake(['png'], 'refuse'), fake(['svg'], 'refuse')]).identify(
      bytes,
      limits,
      'pdf',
    ),
    (err) => {
      assert.ok(err instanceof ResizeSetupError);
      assert.equal(err.code, 'RESIZE_DECODER_MISSING');
      assert.equal(err.retryable, true);
      assert.ok(err.message.includes("'pdf'"), err.message);
      const cause = err.cause as ResizeError;
      assert.ok(ResizeError.isResizeError(cause));
      assert.equal(cause.code, 'RESIZE_SOURCE_FORMAT_UNSUPPORTED');
      return true;
    },
  );

  const unreadable = new Error('unreadable');
  await assert.rejects(
    new DecoderSet([fake(['png'], unreadable)]).identify(bytes, limits, 'pdf'),
    (err) => {
      assert.ok(ResizeError.isResizeError(err));
      assert.equal(err.code, 'RESIZE_DECODER_MISSING');
      assert.equal(err.cause, unreadable);
      assert.ok(err.message.includes('unreadable'), err.message);
      return true;
    },
  );

  await assert.rejects(
    new DecoderSet([
      fake(['png'], new ResizeMediaError('own', { code: 'TEST_OWN' })),
    ]).identify(bytes, limits, 'pdf'),
    { code: 'TEST_OWN' },
  );

  await assert.rejects(
    new DecoderSet([
      fake(['png'], 'refuse'),
      fake(['svg'], 'refuse'),
      fake(['webp'], 'refuse'),
    ]).identify(bytes, limits, 'png'),
    { code: 'RESIZE_SOURCE_FORMAT_UNSUPPORTED', retryable: false },
  );
});

test('an empty or non-string stored format is probed with no mismatch', async () => {
  for (const stored of ['', 42, null]) {
    const first = fake(['png'], 'refuse');
    const second = fake(['webp'], 'accept');
    const result = await new DecoderSet([first, second]).identify(
      bytes,
      limits,
      stored,
    );
    assert.equal(result.decoder, second);
    assert.equal(result.mismatch, undefined);
    assert.equal(first.calls, 1);
  }
});

test('an inspect result outside the contract is RESIZE_DECODER_INVALID', async () => {
  const broken: [string[], Partial<SourceInfo>][] = [
    [['pdf'], { format: 'png' }],
    [['png'], { width: 0 }],
    [['png'], { contentType: '' }],
    [['png'], { pages: 1.5 }],
  ];
  for (const [formats, info] of broken) {
    await assert.rejects(
      new DecoderSet([fake(formats, info)]).identify(bytes, limits),
      (err) => {
        assert.ok(ResizeError.isResizeError(err));
        assert.equal(err.code, 'RESIZE_DECODER_INVALID', JSON.stringify(info));
        assert.ok(err.message.includes(formats[0]), err.message);
        return true;
      },
    );
  }
});

test('createDecoderSet puts the given decoders before the built-in ones', () => {
  const given = fake(['pdf'], 'accept');
  const set = createDecoderSet([given]);
  assert.equal(set.decoders.length, 3);
  assert.equal(set.decoders[0], given);
  assert.ok(set.decoders[1].formats.includes('jpeg'));
  assert.deepEqual(set.decoders[2].formats, ['svg']);
  assert.equal(createDecoderSet().decoders.length, 2);
});

test('SVG bytes are identified by the SVG decoder after the Sharp decoder refuses them', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>',
  );
  const { decoder, info } = await createDecoderSet().identify(svg, limits);
  assert.equal(info.format, 'svg');
  assert.deepEqual(decoder.formats, ['svg']);
});

test('createDecoderSet refuses entries that are not decoders with RESIZE_DECODER_INVALID', () => {
  const inspect = async () => ({
    format: 'pdf',
    contentType: 'application/pdf',
    width: 1,
    height: 1,
  });
  const render = async () => ({
    data: Buffer.alloc(3),
    info: { width: 1, height: 1, channels: 3 as const },
  });
  const cases: [unknown, RegExp][] = [
    ['x', /decoders/],
    [null, /decoders/],
    [[{}], /decoders\[0\]/],
    [[class {}], /decoders\[0\]/],
    [
      [fake(['pdf'], 'accept'), { formats: [], inspect, render }],
      /decoders\[1\]/,
    ],
    [[{ formats: ['pdf'], inspect: 1, render }], /decoders\[0\]/],
  ];
  for (const [extra, message] of cases) {
    assert.throws(
      () => createDecoderSet(extra),
      (err) => {
        assert.ok(ResizeError.isResizeError(err));
        assert.equal(err.code, 'RESIZE_DECODER_INVALID');
        assert.match(err.message, message);
        return true;
      },
    );
  }
});

test("verify() runs each decoder's verify(), in order", async () => {
  const order: string[] = [];
  const first = fake(['png'], 'accept');
  const second = fake(['svg'], 'accept');
  first.verify = () => {
    order.push('png');
  };
  second.verify = async () => {
    order.push('svg');
  };
  await new DecoderSet([first, fake(['gif'], 'accept'), second]).verify();
  assert.deepEqual(order, ['png', 'svg']);

  const failure = new Error('not ready');
  second.verify = async () => {
    throw failure;
  };
  await assert.rejects(new DecoderSet([first, second]).verify(), (err) => {
    assert.equal(err, failure);
    return true;
  });
});
