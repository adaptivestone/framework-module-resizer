// The anchors GitHub gives a markdown file's headings: lower case, no character but a letter, digit,
// space, hyphen or underscore, one hyphen per space, and -1, -2 on a repeat. Fences hold no headings.
export function docAnchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const m of withoutFences(markdown).matchAll(/^#{1,6} (.+)$/gm)) {
    const slug = m[1]
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    anchors.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return anchors;
}

export const withoutFences = (markdown: string): string =>
  markdown.replace(/^ *```[\s\S]*?^ *```/gm, '');
