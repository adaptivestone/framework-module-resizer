// The AWS drivers need optional peers, so the adapter imports a driver only when the config selects
// it, and turns a missing peer into an error that names the config and the packages to install.
import { ResizeSetupError } from '../errors.ts';

/**
 * Import a driver module. A missing package among `peers` is ResizeSetupError RESIZE_PEER_MISSING
 * naming `driver` and `where` (the config that selects it); any other failure stays as it is.
 */
export async function importDriver<T>(
  load: () => Promise<T>,
  driver: string,
  peers: string[],
  where: string,
): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')
    ) {
      const missing = /^Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(
        err.message,
      )?.[1];
      if (missing && peers.includes(missing)) {
        throw new ResizeSetupError(
          `resize config: the '${driver}' driver selected in ${where} requires missing optional peer \`${missing}\` — install ${peers.join(' ')}`,
          { code: 'RESIZE_PEER_MISSING', cause: err },
        );
      }
    }
    throw err;
  }
}
