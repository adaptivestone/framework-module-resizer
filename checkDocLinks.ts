// A release check, run by hand from RELEASE.md: `node checkDocLinks.ts <docs site tree, built>`.
// Links across the two repositories cannot be seen by either one's own checks: this module's docs
// and sources into the guide, read against the built page's ids, and the guide into this module's
// documents, read against their headings. Links between this module's own documents are
// src/docLinks.test.ts's.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { docAnchors } from './src/testHelpers/docAnchors.ts';

const site = process.argv[2];
if (!site) {
  throw new Error('usage: node checkDocLinks.ts <docs site tree, built>');
}
const root = import.meta.dirname;
const read = (...parts: string[]): string =>
  readFileSync(join(...parts), 'utf8');

const page = read(site, 'build/docs/resize/index.html');
const guideIds = new Set(
  [...page.matchAll(/ id=(?:"([^"]+)"|([^\s>]+))/g)].map((m) => m[1] ?? m[2]),
);
const sources = [
  ...['README.md', 'AGENTS.md', 'UPGRADING.md', 'CHANGELOG.md', 'RELEASE.md'],
  ...readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => join('src', file)),
];
const broken: string[] = [];
let intoGuide = 0;
for (const file of sources) {
  for (const m of read(root, file).matchAll(
    /framework\.adaptivestone\.com\/docs\/resize#([\w-]+)/g,
  )) {
    intoGuide += 1;
    if (!guideIds.has(m[1])) {
      broken.push(`${relative(root, join(root, file))} -> guide #${m[1]}`);
    }
  }
}
let intoModule = 0;
for (const m of read(site, 'docs/12-resize.md').matchAll(
  /github\.com\/adaptivestone\/framework-module-resizer(?:\/blob\/[^/\s)]+\/([A-Z]+\.md))?#([\w-]+)/g,
)) {
  intoModule += 1;
  const file = m[1] ?? 'README.md';
  const ok =
    (file === 'README.md' && m[2] === 'readme') ||
    docAnchors(read(root, file)).has(m[2]);
  if (!ok) {
    broken.push(`guide -> ${file}#${m[2]}`);
  }
}
console.log(
  `into the guide: ${intoGuide}, into this module's docs: ${intoModule}, broken: ${broken.length}`,
);
for (const line of broken) {
  console.log(`  ${line}`);
}
process.exitCode = broken.length > 0 ? 1 : 0;
