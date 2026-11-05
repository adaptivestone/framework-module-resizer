// The README's `## Error codes` table, read for the guards that keep it in step with the codes and
// with the audited `retryable` values.
export interface ErrorTableRow {
  code: string;
  retryable: string; // the cell as written: `true`, `false` or —
  text: string;
}

export function errorTableRows(readme: string): ErrorTableRow[] {
  const start = readme.indexOf('\n## Error codes\n');
  if (start < 0) {
    throw new Error('README.md has no "## Error codes" section');
  }
  const end = readme.indexOf('\n### ', start + 1);
  const rows: ErrorTableRow[] = [];
  for (const line of readme.slice(start, end).split('\n')) {
    const m =
      /^\| `(RESIZE_[A-Z0-9_]+)` \| (`true`|`false`|—) \| (.*) \|$/.exec(line);
    if (m) {
      rows.push({ code: m[1], retryable: m[2], text: m[3] });
    } else if (line.startsWith('| `')) {
      throw new Error(`a row the table does not read: ${line.slice(0, 80)}`);
    }
  }
  return rows;
}
