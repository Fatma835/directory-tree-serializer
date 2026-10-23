# Directory Tree Serializer

Walks a directory tree and emits a deterministic JSON structure of paths, sizes, and types — designed for snapshot comparison in test suites.

## Install / Run

No dependencies. ESM only. Node 18+.
```js
import { serializeDirectory } from './src/index.js';

// Point this at any real directory on your machine.
const entries = await serializeDirectory(process.cwd());
console.log(JSON.stringify(entries, null, 2));
```

`serializeDirectory(rootPath)` returns a `Promise<Entry[]>` where each `Entry` is:

```ts
interface Entry {
  path: string;       // '' for root, otherwise 'rel/path' with '/' separators
  size: number;       // bytes, as reported by stat
  type: 'file' | 'directory' | 'other';
}
```

The root directory is always the first element, with `path === ''`. Child paths are relative to the root and forward-slash-separated regardless of platform. Entries are sorted by name (case-sensitive, code-unit order) within each directory, and the walk is depth-first so a directory entry immediately precedes its children.

## Why this exists

The specific problem: asserting that a generated output directory has the shape you expect, across machines and across runs, without committing a thousand-line fixture. Comparing `JSON.stringify(serializeDirectory(out))` against a snapshot gives a one-line diff when a file appears, disappears, changes type, or moves.

The trade-off: this is a *resolved* view of the tree, not a *physical* one. We follow symbolic links with `stat`, so a symlink to a directory is walked as if it were a real subdirectory. This is deliberate — the point is the shape the user sees, not the inode topology — but it means the serializer is not the right tool for detecting symlink graphs. To keep the walk finite in the face of link cycles, a visited-set keyed on the normalized relative path short-circuits re-entry; a cycle entry is still emitted (with `type: 'directory'`) so the snapshot shows that the link existed.

## The awkward edge you will hit

Broken symlinks. `stat` throws on a link whose target is gone; we fall back to `lstat` so the link still appears in the snapshot as `type: 'other'`. If you need to distinguish a broken link from a socket or a FIFO, inspect the tree directly — the serializer collapses all non-file, non-directory things into `'other'`.

Windows is a second awkward edge: symlinks there require elevated privileges, so the symlink tests are skipped under `process.platform === 'win32'` rather than failing the suite. Path separators are normalised to `/` so snapshots are byte-identical across platforms; the root path itself is never emitted.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

