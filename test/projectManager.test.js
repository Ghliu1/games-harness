// Tests for ProjectManager: registry, Unity-project detection, bridge install,
// and (critically) that file access stays scoped inside the active project.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ProjectManager } from '../src/projects/projectManager.js';

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gameforge-'));
}

async function makeUnityProject(dir, name) {
  const p = path.join(dir, name);
  await fs.mkdir(path.join(p, 'Assets', 'Scenes'), { recursive: true });
  return p;
}

test('detects and opens an existing Unity project, installs the bridge', async () => {
  const base = await tmp();
  const projDir = await makeUnityProject(base, 'MyGame');

  // Fake a bridge source so install has something to copy.
  const bridgeSrc = path.join(base, 'unity-bridge', 'Editor');
  await fs.mkdir(bridgeSrc, { recursive: true });
  await fs.writeFile(path.join(bridgeSrc, 'GameForgeBridge.cs'), '// bridge');

  const pm = new ProjectManager({
    registryPath: path.join(base, 'config', 'projects.json'),
    bridgeSourceDir: path.join(base, 'unity-bridge'),
    watch: false,
  });

  await pm.addExisting(projDir, 'MyGame');
  assert.equal(pm.activeSummary().name, 'MyGame');

  // Bridge copied into Assets/GameForge/Editor.
  const installed = path.join(projDir, 'Assets', 'GameForge', 'Editor', 'GameForgeBridge.cs');
  assert.ok(await fs.stat(installed).then(() => true, () => false), 'bridge should be installed');

  // Registry persisted.
  const reg = JSON.parse(await fs.readFile(path.join(base, 'config', 'projects.json'), 'utf-8'));
  assert.equal(reg.length, 1);
  assert.equal(reg[0].path, projDir);
});

test('rejects a non-Unity folder', async () => {
  const base = await tmp();
  const notUnity = path.join(base, 'random');
  await fs.mkdir(notUnity, { recursive: true });
  const pm = new ProjectManager({ registryPath: path.join(base, 'config', 'projects.json'), watch: false });
  await assert.rejects(() => pm.addExisting(notUnity), /not a Unity project/i);
});

test('file access is scoped inside the project', async () => {
  const base = await tmp();
  const projDir = await makeUnityProject(base, 'Scoped');
  const pm = new ProjectManager({ registryPath: path.join(base, 'config', 'projects.json'), watch: false });
  await pm.addExisting(projDir, 'Scoped');

  await pm.writeFile('Assets/Scripts/Test.cs', 'public class Test {}');
  const read = await pm.readFile('Assets/Scripts/Test.cs');
  assert.match(read, /class Test/);

  // Path traversal must be rejected.
  assert.throws(() => pm._resolve('../../etc/passwd'), /escapes project/i);
  await assert.rejects(() => pm.writeFile('../escape.txt', 'x'), /escapes project/i);

  pm.dispose();
});

test('listFiles ignores .meta and generated folders', async () => {
  const base = await tmp();
  const projDir = await makeUnityProject(base, 'Listed');
  await fs.writeFile(path.join(projDir, 'Assets', 'A.cs'), '//a');
  await fs.writeFile(path.join(projDir, 'Assets', 'A.cs.meta'), 'meta');
  await fs.mkdir(path.join(projDir, 'Library'), { recursive: true });
  await fs.writeFile(path.join(projDir, 'Library', 'big.dat'), 'x');

  const pm = new ProjectManager({ registryPath: path.join(base, 'config', 'projects.json'), watch: false });
  await pm.addExisting(projDir, 'Listed');
  const files = await pm.listFiles();
  assert.ok(files.includes('Assets/A.cs'));
  assert.ok(!files.some((f) => f.endsWith('.meta')), 'meta files excluded');
  assert.ok(!files.some((f) => f.startsWith('Library')), 'Library excluded');
  pm.dispose();
});
