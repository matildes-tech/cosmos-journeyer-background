// Removes assets the background page never uses from a built dist.
//
// Vite emits them because Cosmos Journeyer's modules import them eagerly, even
// though this page installs the mock sound player and never plays a note. They
// are dropped after the build rather than by editing their imports, so the
// vendored engine stays untouched.
import { readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('./dist/assets/', import.meta.url).pathname;
const DROP = /\.(ogg|mp3|wav)$/i;

let bytes = 0;
let count = 0;
for (const name of readdirSync(DIST)) {
  if (!DROP.test(name)) continue;
  const path = join(DIST, name);
  bytes += statSync(path).size;
  rmSync(path);
  count++;
}
console.log(`pruned ${count} audio files, ${(bytes / 1048576).toFixed(1)} MB`);
