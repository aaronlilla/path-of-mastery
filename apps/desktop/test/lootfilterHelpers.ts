import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** dist-test/test -> apps/desktop/resources/neversink/8.20.1d */
export const NEVERSINK_DIR = resolve(here, '..', '..', 'resources', 'neversink', '8.20.1d');
