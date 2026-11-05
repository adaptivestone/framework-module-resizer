// A release check, run by hand from RELEASE.md: `node checkDocLinks.ts <docs site tree, built>`.
// Links across the two repositories cannot be seen by either one's own checks: this module's docs,
// sources, scaffold templates and docs/ into the guide, read against the built page's ids, and the
// guide into this module's files, read against the files and their headings. Links between this
// module's own documents are src/docLinks.test.ts's.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { docAnchors } from './src/testHelpers/docAnchors.ts';

const site = process.argv[2];
if (!site) {
  throw new Error('usage: node checkDocLinks.ts <docs site tree, built>');
}
const root = import.meta.dirname;
const read = (...parts: string[]): string =>
  readFileSync(join(...parts), 'utf8');
const filesUnder = (dir: string, keep: (file: string) => boolean): string[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter(keep)
    .map((file) => join(dir, file));

const page = read(site, 'build/docs/resize/index.html');
const guideIds = new Set(
  [...page.matchAll(/ id=(?:"([^"]+)"|([^\s>]+))/g)].map((m) => m[1] ?? m[2]),
);
// The scaffold's templates are written into host apps, so their links reach hosts too.
const sources = [
  ...['README.md', 'AGENTS.md', 'UPGRADING.md', 'CHANGELOG.md', 'RELEASE.md'],
  ...filesUnder(
    'src',
    (file) =>
      (file.endsWith('.ts') && !file.endsWith('.test.ts')) ||
      file.endsWith('.tpl'),
  ),
  ...filesUnder('docs', (file) => file.endsWith('.md')),
];
const broken: string[] = [];
let intoGuide = 0;
for (const file of sources) {
  if (!existsSync(join(root, file))) {
    broken.push(`${file} (no such file)`);
    continue;
  }
  for (const m of read(root, file).matchAll(
    /framework\.adaptivestone\.com\/docs\/resize#([\w-]+)/g,
  )) {
    intoGuide += 1;
    if (!guideIds.has(m[1])) {
      broken.push(`${file} -> guide #${m[1]}`);
    }
  }
}
// The README (no path), or a Markdown file at any depth, through `blob/` or `tree/`, with an optional
// query such as `?plain=1` and an optional anchor. A link pinned to a tag reads that release's
// files, which this tree cannot check: it is counted and skipped.
const MODULE_LINK =
  /github\.com\/adaptivestone\/framework-module-resizer(?:\/(?:blob|tree)\/([^/\s)#?]+)\/([\w./-]+\.md)\b)?(?:\?[^\s)#]*)?(?:#([\w-]+))?/g;
const TAG = /^v?\d+\.\d+\.\d+/;
let intoModule = 0;
let pinned = 0;
for (const [, ref, path, anchor] of read(site, 'docs/12-resize.md').matchAll(
  MODULE_LINK,
)) {
  if (path === undefined && anchor === undefined) {
    continue; // the repository itself, or a file that is not Markdown
  }
  if (ref !== undefined && TAG.test(ref)) {
    pinned += 1;
    continue;
  }
  intoModule += 1;
  const file = path ?? 'README.md';
  if (!existsSync(join(root, file))) {
    broken.push(`guide -> ${file} (no such file)`);
    continue;
  }
  const ok =
    anchor === undefined ||
    (file === 'README.md' && anchor === 'readme') ||
    docAnchors(read(root, file)).has(anchor);
  if (!ok) {
    broken.push(`guide -> ${file}#${anchor}`);
  }
}
console.log(
  `into the guide: ${intoGuide}, into this module's docs: ${intoModule}, pinned to a tag (not checked): ${pinned}, broken: ${broken.length}`,
);
for (const line of broken) {
  console.log(`  ${line}`);
}
process.exitCode = broken.length > 0 ? 1 : 0;
