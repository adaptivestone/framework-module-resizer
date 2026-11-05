// Test-only: a decoder with no image library, for sources written by encodePng.
import {
  type DecodeBox,
  type Raster,
  type RenderOptions,
  SourceDecoder,
  type SourceInfo,
} from '../contracts/decoder.ts';
import { ResizeMediaError } from '../errors.ts';
import { decodePng } from './fakeEngine.ts';

export class FakePngDecoder extends SourceDecoder {
  readonly formats = ['png'];
  async inspect(bytes: Buffer): Promise<SourceInfo> {
    if (bytes.readUInt32BE(0) !== 0x89504e47) {
      throw new ResizeMediaError('fake: not png', {
        code: 'RESIZE_SOURCE_FORMAT_UNSUPPORTED',
        retryable: false,
      });
    }
    const { width, height } = decodePng(bytes).info;
    return { format: 'png', contentType: 'image/png', width, height, pages: 1 };
  }
  async render(
    bytes: Buffer,
    _box: DecodeBox,
    _opts: RenderOptions,
  ): Promise<Raster> {
    return decodePng(bytes);
  }
}
