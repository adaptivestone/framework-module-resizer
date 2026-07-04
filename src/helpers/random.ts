// INTERNAL utility — hex token generator. NOT exported from the main entry.
// Used for lease fencing tokens (05 · §10.2) and unguessable preview keys (07 · step 7).
import { randomBytes } from 'node:crypto';

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}
