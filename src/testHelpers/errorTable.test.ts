import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorTableRows } from './errorTable.ts';

test('a table that ends the file keeps its last row, also with no newline after it', () => {
  for (const tail of ['', '\n']) {
    assert.deepEqual(
      errorTableRows(
        `\n## Error codes\n\n| \`RESIZE_A\` | \`true\` | Text. |${tail}`,
      ),
      [{ code: 'RESIZE_A', retryable: '`true`', text: 'Text.' }],
    );
  }
});

test('the table ends at the next ### heading', () => {
  assert.deepEqual(
    errorTableRows(
      '\n## Error codes\n\n| `RESIZE_A` | — | Text. |\n### Next\n\n| `RESIZE_B` | `false` | Not read. |\n',
    ).map((row) => row.code),
    ['RESIZE_A'],
  );
});
