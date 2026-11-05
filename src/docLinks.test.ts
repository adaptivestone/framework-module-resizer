// Links between this repository's documents: every relative link, and every link to a file of this
// repository on GitHub, names a file that exists, every anchor names a heading, and a shipped document
// links only to files the package ships. A link into dist/ is checked against the source it is built
// from. Links into the guide, and from it, are checked against a build of the docs site at release
// (see RELEASE.md).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { docAnchors, withoutFences } from './testHelpers/docAnchors.ts';

const repo = new URL('../', import.meta.url);
const read = (file: string): string =>
  readFileSync(new URL(file, repo), 'utf8');
const exists = (file: string): boolean => existsSync(new URL(file, repo));

const SHIPPED = ['README.md', 'AGENTS.md', 'UPGRADING.md'];
const DOCS = [...SHIPPED, 'RELEASE.md', 'CHANGELOG.md'];
const MODULE_URL =
  /github\.com\/adaptivestone\/framework-module-resizer(?:\/blob\/[^/\s)]+\/([^\s)#]+\.md))?#([\w-]+)/g;
// A file of this repository on GitHub, with or without an anchor.
const MODULE_FILE =
  /github\.com\/adaptivestone\/framework-module-resizer\/(?:blob|tree)\/[^/\s)]+\/([^\s)#`'"<>]+)/g;

// dist/ exists only after a build: dist/a/b.d.ts and dist/a/b.js are built from src/a/b.ts, and a
// hand-written src/a/b.d.ts (src/types.d.ts) is copied as it is. The build leaves out tests and test
// helpers (the `exclude` of tsconfig.json), so a dist/ path to one has no source.
const sourcesOf = (path: string): string[] => {
  if (!path.startsWith('dist/')) {
    return [path];
  }
  const source = path.replace(/^dist\//, 'src/');
  if (
    source.startsWith('src/testHelpers/') ||
    /\.test\.(?:d\.ts|js|ts)$/.test(source)
  ) {
    return [];
  }
  return [source.replace(/(?:\.d\.ts|\.js)$/, '.ts'), source];
};

const relativeLinks = (file: string) => [
  ...withoutFences(read(file)).matchAll(
    /\]\((?!https?:|mailto:)(?:\.?\/)?([^)#\s]*)(?:#([^)\s]+))?\)/g,
  ),
];

test('the slug rule gives the anchors the documents already rely on', () => {
  const readme = docAnchors(read('README.md'));
  for (const anchor of [
    'prewarm-issues',
    'adoptoriginal',
    'push-delivery-preview',
    'error-codes',
    'symptoms-without-a-code',
  ]) {
    assert.ok(readme.has(anchor), anchor);
  }
});

test('every link between the documents reaches a file and a heading', () => {
  const broken: string[] = [];
  let links = 0;
  for (const file of DOCS) {
    for (const [, path, anchor] of relativeLinks(file)) {
      links += 1;
      const target = path || file;
      if (!sourcesOf(target).some(exists)) {
        broken.push(`${file}: ${target}`);
      } else if (
        anchor &&
        target.endsWith('.md') &&
        !docAnchors(read(target)).has(anchor)
      ) {
        broken.push(`${file}: ${target}#${anchor}`);
      }
    }
    for (const [, found] of read(file).matchAll(MODULE_FILE)) {
      links += 1;
      const path = found.replace(/[.,;:]+$/, ''); // the end of a sentence, not of the path
      if (!exists(path)) {
        broken.push(`${file}: github ${path}`);
      }
    }
    for (const [, path, anchor] of read(file).matchAll(MODULE_URL)) {
      links += 1;
      const target = path ?? 'README.md';
      const ok =
        (target === 'README.md' && anchor === 'readme') ||
        (exists(target) && docAnchors(read(target)).has(anchor));
      if (!ok) {
        broken.push(`${file}: github ${target}#${anchor}`);
      }
    }
  }
  assert.deepEqual(broken, []);
  assert.ok(links >= 40, `only ${links} links read`);
});

test('a shipped document links only to files the package ships', () => {
  const pack = JSON.parse(read('package.json')) as { files: string[] };
  const ships = (path: string) =>
    ['README.md', 'LICENSE', ...pack.files].some(
      (f) => path === f || path.startsWith(`${f}/`),
    );
  const problems: string[] = [];
  for (const doc of SHIPPED) {
    for (const [, path] of relativeLinks(doc)) {
      if (path && !ships(path)) {
        problems.push(`${doc}: ${path}`);
      }
    }
    // A file named in plain text, outside a link, is a pointer a reader of node_modules cannot follow.
    const prose = withoutFences(read(doc)).replace(/\[[^\]]*\]\([^)]*\)/g, '');
    for (const [name] of prose.matchAll(/\b(?:RELEASE|CHANGELOG)\.md\b/g)) {
      problems.push(`${doc}: names ${name}`);
    }
  }
  assert.deepEqual(problems, []);
});
