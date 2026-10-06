// Child process of svgRaster.ts — never import this module: it reads stdin and exits.
// Renders ONE SVG to a lossless PNG. librsvg renders inside one native call that sharp's
// `.timeout()` cannot interrupt, so the parent runs it here and kills this process at its deadline.
//   argv[2]: JSON { density, limitInputPixels, timeoutMs }
//   stdin:   the SVG bytes
//   fd 3:    the PNG bytes (a pipe of its own: stdout is discarded, so whatever a host preload
//            prints there cannot reach the image)
//   failure: a message on stderr and a non-zero exit code
// `sharp` resolves from this file's own location (the package), whatever the host's cwd.
import { Socket } from 'node:net';
import sharp from 'sharp';

const { density, limitInputPixels, timeoutMs } = JSON.parse(
  process.argv[2] ?? '{}',
) as { density: number; limitInputPixels: number; timeoutMs: number };

// The render runs on a libuv thread, so this timer still fires during it: a safety net if the
// parent is gone and cannot kill this process. The parent's own deadline comes first.
setTimeout(() => process.exit(2), timeoutMs + 5000).unref();

sharp.cache(false);
sharp.concurrency(1);

try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  // Same safety options as any decode in the worker. A buffer input has no base location, so
  // librsvg loads no external file, URL or stylesheet reference.
  const png = await sharp(Buffer.concat(chunks), {
    density,
    failOn: 'warning',
    limitInputPixels,
  })
    .png({ compressionLevel: 1 })
    .toBuffer();
  // A stream over fd 3 (like process.stdout over a pipe) copes with a non-blocking pipe; exit
  // by draining, not process.exit(), so the whole PNG reaches the parent.
  new Socket({ fd: 3, readable: false, writable: true }).end(png);
} catch (err) {
  process.stderr.write(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
