import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const FILE_TYPE = 'file';
const DIRECTORY_TYPE = 'directory';
const OTHER_TYPE = 'other';

/**
 * Normalises a single component of a path to a forward-slash separator, so that
 * the serialised tree is byte-identical across POSIX and Windows. We split on
 * the platform's native separator and join with '/'; this happens per component
 * rather than once on the whole path so that a stray '\' inside a filename on
 * POSIX (a legal, if unwise, name) is preserved literally instead of being
 * treated as a separator.
 *
 * @param {string} component
 * @returns {string}
 */
function normalizeComponent(component) {
  if (typeof component !== 'string') {
    throw new TypeError(`Path components must be strings; received ${String(component)}`);
  }
  return component.split('\\').join('/');
}

/**
 * Traverses a directory tree depth-first and returns a deterministically
 * ordered array of entries. Depth-first is used so that, for any given
 * directory, its own entry immediately precedes its children — which makes
 * the output readable top-to-bottom. Children within a directory are sorted by
 * their case-sensitive UTF-16 code-unit sequence, which is what Array#sort
 * does by default; this avoids locale-dependent ordering, which would break
 * determinism across machines with different LANG settings.
 *
 * Symbolic links are followed when stat resolves them, but are never recursed
 * into as directories even if they point at one — see the lstat note on the
 * caller. We deliberately treat stat's view as authoritative: the library is
 * for snapshotting the *resolved* shape of a tree, not for detecting links.
 *
 * A visited set guards against cycles that arise when one subdirectory is
 * reached through two parents via symlinks. This only catches directory cycles
 * (which would otherwise infinite-loop); file entries are emitted as many
 * times as the walk reaches them, since a hard-linked file reaching us twice
 * is the user's tree to snapshot, not ours to deduplicate.
 *
 * @param {string} dirPath Absolute or relative path on disk.
 * @param {string[]} basePathParts Already-normalised components of dirPath.
 * @param {Set<string>} visited Absolute real paths already entered as directories.
 * @returns {Promise<Array<object>>}
 */
async function walk(dirPath, basePathParts, visited) {
  const names = await readdir(dirPath);
  names.sort();

  const results = [];
  for (const name of names) {
    const childDiskPath = join(dirPath, name);
    const childParts = [...basePathParts, normalizeComponent(name)];
    const childPath = childParts.join('/');

    let stats;
    try {
      stats = await stat(childDiskPath);
    } catch (error) {
      // We use lstat when stat fails on a broken symlink so the link still
      // appears in the snapshot as an 'other' entry rather than vanishing.
      stats = await stat(childDiskPath).catch(async () => {
        const { lstat } = await import('node:fs/promises');
        return lstat(childDiskPath);
      });
    }

    if (stats.isDirectory()) {
      if (visited.has(childPath)) {
        results.push({ path: childPath, size: stats.size, type: DIRECTORY_TYPE, cycle: true });
        continue;
      }
      visited.add(childPath);
      results.push({ path: childPath, size: stats.size, type: DIRECTORY_TYPE });
      const children = await walk(childDiskPath, childParts, visited);
      for (const c of children) results.push(c);
    } else if (stats.isFile()) {
      results.push({ path: childPath, size: stats.size, type: FILE_TYPE });
    } else {
      results.push({ path: childPath, size: stats.size, type: OTHER_TYPE });
    }
  }
  return results;
}

/**
 * Serialise a directory tree to a deterministic JSON-structure array.
 *
 * Each entry has the shape:
 *   { path: string, size: number, type: 'file' | 'directory' | 'other' }
 *
 * The root directory itself is the first element; its `path` is '' (empty
 * string) regardless of input, so snapshots are identical no matter where the
 * tree was copied on the tester's machine. Child paths are relative to the
 * root, '/'-separated, and the root prefix is stripped.
 *
 * Throws if `rootPath` is not a directory or does not exist. A non-string
 * argument throws synchronously before any I/O begins.
 *
 * @param {string} rootPath Directory to walk.
 * @returns {Promise<object[]>} Deterministic, ordered list of entries.
 */
export async function serializeDirectory(rootPath) {
  if (typeof rootPath !== 'string') {
    throw new TypeError(`rootPath must be a string; received ${Object.prototype.toString.call(rootPath)}`);
  }
  if (rootPath === '') {
    throw new TypeError('rootPath must not be empty');
  }

  const rootStats = await stat(rootPath);
  if (!rootStats.isDirectory()) {
    throw new Error(`rootPath is not a directory: ${rootPath}`);
  }

  const visited = new Set();
  visited.add('');

  const children = await walk(rootPath, [], visited);
  return [{ path: '', size: rootStats.size, type: DIRECTORY_TYPE }, ...children];
}
