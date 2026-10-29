// Test-only: a decoder for a source kind the package does not ship, to prove that a host adds one
// through `new Resizer({ decoders })` with no core change. Its "PDF" is a marker and a JSON body
// (size and colour), so the tests need no PDF engine; it renders a solid colour at any box.
import {
  type DecodeBox,
  type Raster,
  SourceDecoder,
  type SourceInfo,
} from '../contracts/decoder.ts';
import { ResizeMediaError } from '../errors.ts';

const MARKER = '%PDF-fake ';

interface FakePdfBody {
  width: number;
  height: number;
  color: [number, number, number];
}

/** The bytes of a fake one-page PDF of `width` × `height` in one `color`. */
export function fakePdf(
  width: number,
  height: number,
  color: [number, number, number],
): Buffer {
  const body: FakePdfBody = { width, height, color };
  return Buffer.from(`${MARKER}${JSON.stringify(body)}`);
}

function parse(bytes: Buffer): FakePdfBody {
  if (!bytes.subarray(0, MARKER.length).equals(Buffer.from(MARKER))) {
    throw new ResizeMediaError('test pdf decoder: not a fake PDF', {
      code: 'RESIZE_SOURCE_FORMAT_UNSUPPORTED',
      retryable: false,
    });
  }
  return JSON.parse(bytes.subarray(MARKER.length).toString('utf8'));
}

export class TestPdfDecoder extends SourceDecoder {
  readonly formats = ['pdf'];
  /** Every box render() was asked for, in order. */
  readonly renders: DecodeBox[] = [];

  async inspect(bytes: Buffer): Promise<SourceInfo> {
    const { width, height } = parse(bytes);
    return {
      format: 'pdf',
      contentType: 'application/pdf',
      width,
      height,
      vector: true,
    };
  }

  /** A solid raster of exactly `box`, in the page's colour. */
  async render(bytes: Buffer, box: DecodeBox): Promise<Raster> {
    const { color } = parse(bytes);
    this.renders.push({ width: box.width, height: box.height });
    const data = Buffer.alloc(box.width * box.height * 3);
    for (let i = 0; i < data.length; i += 3) {
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
    }
    return {
      data,
      info: { width: box.width, height: box.height, channels: 3 },
    };
  }
}
