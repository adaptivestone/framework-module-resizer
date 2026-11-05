// The AWS drivers need optional peers, so a driver is imported only when the config selects it,
// and a missing peer becomes an error that names the config and the packages to install. Before
// any import, probePeers asks the module resolver whether the peers are there, which loads
// nothing, so a backend whose SDK is missing can be left out without touching its driver.
import { ResizeSetupError } from '../errors.ts';

const isModuleNotFound = (err: unknown): err is Error & { code: string } =>
  err instanceof Error &&
  'code' in err &&
  (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND');

/** RESIZE_PEER_MISSING: `driver`, selected in `where`, needs `missing`, one of `peers`. */
function peerMissing(
  driver: string,
  missing: string,
  peers: readonly string[],
  where: string,
  cause: unknown,
): ResizeSetupError {
  return new ResizeSetupError(
    `resize config: the '${driver}' driver selected in ${where} requires missing optional peer \`${missing}\` — install ${peers.join(' ')}`,
    { code: 'RESIZE_PEER_MISSING', cause },
  );
}

/**
 * The package a module-not-found error names, or undefined for any other error. A relative path
 * or a deep import names something else, so it matches no peer's name.
 */
export function missingPackageOf(err: unknown): string | undefined {
  if (!isModuleNotFound(err)) {
    return undefined;
  }
  return /^Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(
    err.message,
  )?.[1];
}

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
    const missing = missingPackageOf(err);
    if (missing && peers.includes(missing)) {
      throw peerMissing(driver, missing, peers, where, err);
    }
    throw err;
  }
}

/**
 * The RESIZE_PEER_MISSING error of the first of `peers` that `resolve` cannot find (the same
 * error importDriver throws), or undefined when every peer resolves. `resolve` is the caller's
 * import.meta.resolve, which loads nothing; any other resolution failure counts as found, so the
 * driver's own import reports it.
 */
export function probePeers(
  peers: readonly string[],
  driver: string,
  where: string,
  resolve: (specifier: string) => string,
): ResizeSetupError | undefined {
  for (const peer of peers) {
    try {
      resolve(peer);
    } catch (err) {
      if (isModuleNotFound(err)) {
        return peerMissing(driver, peer, peers, where, err);
      }
    }
  }
  return undefined;
}
