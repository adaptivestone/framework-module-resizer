import fs from 'node:fs/promises';

console.info('preBuild. Removing dist folder');
console.time('preBuild. Removing dist folder. Done');
try {
  await fs.rm('./dist', { recursive: true });
} catch {}
console.timeEnd('preBuild. Removing dist folder. Done');
