import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeDirectory } from '../src/index.js';

/**
 * Each test gets its own freshly-built tree under a unique OS temp dir. We
 * clean up eagerly in a finally block rather than in a test.afterAll hook so
 * that a crashed process never leaks state into the next run.
 */
async function makeTempTree(builder) {
  const dir = await mkdtemp(join(tmpdir(), 'dts-'));
  try {
    await builder(dir);
    return dir;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function cleanup(dir) {
  if (dir) await rm(dir, { recursive: true, force: true });
}

test('root directory is the first entry with an empty path', async () => {
  const dir = await makeTempTree(async (d) => {
    await writeFile(join(d, 'a.txt'), 'hello');
  });
  try {
    const entries = await serializeDirectory(dir);
    assert.equal(entries[0].path, '');
    assert.equal(entries[0].type, 'directory');
    assert.equal(typeof entries[0].size, 'number');
  } finally {
    await cleanup(dir);
  }
});

test('files are listed with their sizes', async () => {
  const dir = await makeTempTree(async (d) => {
    await writeFile(join(d, 'a.txt'), 'hello');
    await writeFile(join(d, 'b.txt'), 'world!');
  });
  try {
    const entries = await serializeDirectory(dir);
    const paths = entries.map((e) => e.path);
    assert.deepEqual(paths, ['', 'a.txt', 'b.txt']);
    const a = entries.find((e) => e.path === 'a.txt');
    assert.equal(a.size, 5);
    assert.equal(a.type, 'file');
    const b = entries.find((e) => e.path === 'b.txt');
    assert.equal(b.size, 6);
  } finally {
    await cleanup(dir);
  }
});

test('directories contain children and are emitted before them', async () => {
  const dir = await makeTempTree(async (d) => {
    await mkdir(join(d, 'sub'));
    await writeFile(join(d, 'sub', 'child.txt'), 'c');
  });
  try {
    const entries = await serializeDirectory(dir);
    const paths = entries.map((e) => e.path);
    assert.deepEqual(paths, ['', 'sub', 'sub/child.txt']);
    assert.equal(entries[1].type, 'directory');
    assert.equal(entries[2].type, 'file');
  } finally {
    await cleanup(dir);
  }
});

test('entries are sorted by name within each directory', async () => {
  const dir = await makeTempTree(async (d) => {
    await writeFile(join(d, 'z.txt'), 'z');
    await writeFile(join(d, 'a.txt'), 'a');
    await mkdir(join(d, 'm'));
    await writeFile(join(d, 'm', 'y.txt'), 'y');
    await writeFile(join(d, 'm', 'x.txt'), 'x');
  });
  try {
    const entries = await serializeDirectory(dir);
    const paths = entries.map((e) => e.path);
    assert.deepEqual(paths, ['', 'a.txt', 'm', 'm/x.txt', 'm/y.txt', 'z.txt']);
  } finally {
    await cleanup(dir);
  }
});

test('deeply nested trees are walked recursively', async () => {
  const dir = await makeTempTree(async (d) => {
    await mkdir(join(d, 'a'), { recursive: true });
    await mkdir(join(d, 'a', 'b'), { recursive: true });
    await writeFile(join(d, 'a', 'b', 'c.txt'), 'deep');
  });
  try {
    const entries = await serializeDirectory(dir);
    const paths = entries.map((e) => e.path);
    assert.deepEqual(paths, ['', 'a', 'a/b', 'a/b/c.txt']);
  } finally {
    await cleanup(dir);
  }
});

test('rejects a non-directory root with a thrown error', async () => {
  const dir = await makeTempTree(async (d) => {
    await writeFile(join(d, 'file.txt'), 'x');
  });
  try {
    await assert.rejects(
      () => serializeDirectory(join(dir, 'file.txt')),
      /not a directory/,
    );
  } finally {
    await cleanup(dir);
  }
});

test('rejects a missing root path with a thrown error', async () => {
  await assert.rejects(
    () => serializeDirectory(join(tmpdir(), 'dts-does-not-exist-' + process.pid)),
    { name: 'Error' },
  );
});

test('rejects a non-string argument synchronously', async () => {
  await assert.rejects(() => serializeDirectory(null), /must be a string/);
  await assert.rejects(() => serializeDirectory(42), /must be a string/);
});

test('rejects an empty string root', async () => {
  await assert.rejects(() => serializeDirectory(''), /must not be empty/);
});

test('empty directory yields only the root entry', async () => {
  const dir = await makeTempTree(async () => {});
  try {
    const entries = await serializeDirectory(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'directory');
  } finally {
    await cleanup(dir);
  }
});

test('snapshot is deterministic across two runs on the same tree', async () => {
  const dir = await makeTempTree(async (d) => {
    await mkdir(join(d, 'z'));
    await mkdir(join(d, 'a'));
    await writeFile(join(d, 'z', '1.txt'), 'one');
    await writeFile(join(d, 'a', '2.txt'), 'two');
  });
  try {
    const first = await serializeDirectory(dir);
    const second = await serializeDirectory(dir);
    assert.deepEqual(first, second);
  } finally {
    await cleanup(dir);
  }
});

test('byte-for-byte equality holds under JSON.stringify (snapshot contract)', async () => {
  const dir = await makeTempTree(async (d) => {
    await mkdir(join(d, 'a'));
    await writeFile(join(d, 'a', 'f.txt'), 'x');
    await writeFile(join(d, 'g.txt'), 'y');
  });
  try {
    const a = await serializeDirectory(dir);
    const b = await serializeDirectory(dir);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  } finally {
    await cleanup(dir);
  }
});

test('broken symlink is recorded as an other entry rather than crashing', { skip: process.platform === 'win32' }, async () => {
  const dir = await makeTempTree(async (d) => {
    await symlink('/tmp/dts-target-that-does-not-exist-' + process.pid, join(d, 'dangling'));
  });
  try {
    const entries = await serializeDirectory(dir);
    const link = entries.find((e) => e.path === 'dangling');
    assert.ok(link, 'dangling link missing from output');
    assert.equal(link.type, 'other');
  } finally {
    await cleanup(dir);
  }
});

test('directory reached via symlink is walked but does not infinite-loop', { skip: process.platform === 'win32' }, async () => {
  // We point a symlink at the root itself, then walk. Without cycle
  // detection this would recurse forever. With it, we expect the symlink's
  // target directory to be entered once and then short-circuited the second
  // time we try to enter it under the link's path.
  const dir = await makeTempTree(async (d) => {
    await writeFile(join(d, 'real.txt'), 'r');
    await mkdir(join(d, 'sub'));
    await writeFile(join(d, 'sub', 'child.txt'), 'c');
    await symlink(d, join(d, 'selflink'));
  });
  try {
    const entries = await serializeDirectory(dir);
    const paths = entries.map((e) => e.path);
    // The selflink directory is entered, then its (already-visited) children
    // are skipped. We assert the selflink entry exists and appears once, and
    // that the walk terminated.
    const selfLinks = paths.filter((p) => p === 'selflink');
    assert.equal(selfLinks.length, 1, 'selflink directory entry should appear exactly once');
    // The real children should still be present.
    assert.ok(paths.includes('real.txt'));
    assert.ok(paths.includes('sub'));
    assert.ok(paths.includes('sub/child.txt'));
  } finally {
    await cleanup(dir);
  }
});
