/**
 * Prints the fingerprint file of a key file: SHA-256 slices only, never the key. Give the result to models with
 * MODELS_KEY_FINGERPRINTS=<path>, so it refuses any prompt holding that key without ever holding the key.
 *
 *   npm run fingerprint -w services/models -- <key file> [name] > brave.fingerprint.json
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fingerprint } from '../src/keyguard.ts';

const [file, name] = process.argv.slice(2);
if (!file) {
  process.stderr.write('usage: fingerprint <key file> [name]\n');
  process.exit(2);
}
process.stdout.write(JSON.stringify(fingerprint(name ?? basename(file), readFileSync(file, 'utf8'))) + '\n');
