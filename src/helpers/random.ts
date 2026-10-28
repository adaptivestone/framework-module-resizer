// INTERNAL utility — hex token generator. NOT exported from the main entry.
// Used for lease fencing tokens and unguessable preview keys.
import { randomBytes } from 'node:crypto';

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}
