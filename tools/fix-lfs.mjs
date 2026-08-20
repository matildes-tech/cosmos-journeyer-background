//  Replaces Git LFS pointer files with their real contents.
//
//  Cosmos Journeyer stores its textures, models and wasm through Git LFS. A
//  plain `git clone` on a machine without git-lfs installed leaves behind small
//  text pointers wearing the original filenames, and the build then fails deep
//  inside asset loading with an unhelpful error — a .webp whose first bytes are
//  "version https://..." rather than "RIFF", a .wasm whose magic number is the
//  ASCII "vers".
//
//  Installing git-lfs is the tidy fix. This exists for when you cannot, and
//  fetches each object straight from GitHub's media host instead. The declared
//  size in the pointer is checked against what arrives, so a truncated download
//  or an HTML error page cannot masquerade as an asset.

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const POINTER_MAGIC = "version https://git-lfs.github.com/spec/v1";
const SKIP = new Set(["node_modules", ".git", "dist", "deploy-stage"]);
const CONCURRENCY = 8;

const root = process.argv[2] ?? ".";
const repo = process.argv[3] ?? "BarthPaleologue/CosmosJourneyer";
const ref = process.argv[4] ?? "main";

/** Reads just enough of a file to tell a pointer from real content. */
async function readPointer(path) {
    const info = await stat(path);
    // Pointers are a few hundred bytes at most; anything larger is real content.
    if (info.size > 1024) return null;
    const text = await readFile(path, "utf8").catch(() => "");
    if (!text.startsWith(POINTER_MAGIC)) return null;
    const size = /^size (\d+)$/m.exec(text);
    return { size: size ? Number(size[1]) : null };
}

async function* walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(path);
        else if (entry.isFile()) yield path;
    }
}

async function fetchObject(path, pointer) {
    const rel = relative(root, path).split(sep).map(encodeURIComponent).join("/");
    const url = `https://media.githubusercontent.com/media/${repo}/${ref}/${rel}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${rel}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (pointer.size !== null && bytes.length !== pointer.size) {
        // Usually an HTML error page served with 200, which would otherwise be
        // written out under an asset's name and fail much later, far from here.
        throw new Error(`size mismatch for ${rel}: expected ${pointer.size}, got ${bytes.length}`);
    }
    await writeFile(path, bytes);
    return bytes.length;
}

const pending = [];
for await (const path of walk(root)) {
    const pointer = await readPointer(path);
    if (pointer) pending.push({ path, pointer });
}

if (pending.length === 0) {
    console.log("No LFS pointers found — nothing to do.");
    process.exit(0);
}

console.log(`Found ${pending.length} LFS pointer(s); fetching from ${repo}@${ref}`);

let done = 0;
let failed = 0;
let cursor = 0;
await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
        while (cursor < pending.length) {
            const { path, pointer } = pending[cursor++];
            try {
                await fetchObject(path, pointer);
                done += 1;
            } catch (error) {
                failed += 1;
                console.error(`  FAILED ${relative(root, path)}: ${error.message}`);
            }
        }
    }),
);

console.log(`Restored ${done}/${pending.length} object(s)${failed ? `, ${failed} failed` : ""}.`);
process.exit(failed ? 1 : 0);
