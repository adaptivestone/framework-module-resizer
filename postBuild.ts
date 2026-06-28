import fs from 'node:fs/promises';

console.info('postBuild. Copying non-TS assets into dist');
console.time('postBuild. Done');

// Assets tsc does not emit. Some are optional and may not exist yet during early
// development, so copy each independently and skip the ones that are absent.
const paths = ['types.d.ts', 'assets', 'scaffold/templates'];

await Promise.all(
  paths.map(async (path) => {
    try {
      await fs.cp(`./src/${path}`, `./dist/${path}`, { recursive: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        console.info(`postBuild. Skipping missing ./src/${path}`);
        return;
      }
      throw e;
    }
  }),
);

console.timeEnd('postBuild. Done');
