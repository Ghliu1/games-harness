// Tests for the agent tool layer: schemas are well-formed, file tools operate
// through the project, and Unity tools fail gracefully when Unity is offline.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTools } from '../src/ai/tools.js';

function mockProjects() {
  const store = new Map();
  return {
    store,
    async listFiles() { return [...store.keys()]; },
    async readFile(p) { if (!store.has(p)) throw new Error('no such file'); return store.get(p); },
    async writeFile(p, c) { store.set(p, c); },
    async deleteFile(p) { store.delete(p); },
  };
}

const offlineBridge = { async ping() { return null; }, async rpc() { throw new Error('should not be called'); } };
const onlineBridge = {
  async ping() { return { ok: true, unityVersion: '2022.3.0f1', projectName: 'X', isPlaying: false }; },
  async rpc(method, params) { return `ran ${method}`; },
  async screenshot() { return 'data:image/png;base64,AAAA'; },
};

test('every tool has a name, description, and object schema', () => {
  const { schemas } = buildTools({ projects: mockProjects(), bridge: offlineBridge });
  assert.ok(schemas.length > 10);
  for (const s of schemas) {
    assert.ok(s.name, 'name');
    assert.ok(s.description, `description for ${s.name}`);
    assert.equal(s.input_schema.type, 'object', `${s.name} schema type`);
  }
});

test('file tools read/write/list through the project', async () => {
  const projects = mockProjects();
  const { handlers } = buildTools({ projects, bridge: offlineBridge });

  const w = await handlers.write_file({ path: 'Assets/Scripts/A.cs', content: 'class A {}' });
  assert.match(w, /Wrote/);
  assert.equal(await handlers.read_file({ path: 'Assets/Scripts/A.cs' }), 'class A {}');
  assert.match(await handlers.list_files({}), /Assets\/Scripts\/A\.cs/);

  const edit = await handlers.apply_edit({ path: 'Assets/Scripts/A.cs', find: 'class A {}', replace: 'class A { int x; }' });
  assert.match(edit, /Edited/);
  assert.match(await handlers.read_file({ path: 'Assets/Scripts/A.cs' }), /int x/);
});

test('apply_edit reports non-unique matches', async () => {
  const projects = mockProjects();
  await projects.writeFile('a.txt', 'x x');
  const { handlers } = buildTools({ projects, bridge: offlineBridge });
  const res = await handlers.apply_edit({ path: 'a.txt', find: 'x', replace: 'y' });
  assert.match(res, /appears 2 times/);
});

test('unity tools error clearly when the editor is offline', async () => {
  const { handlers } = buildTools({ projects: mockProjects(), bridge: offlineBridge });
  await assert.rejects(() => handlers.refresh_assets({}), /not connected/i);
  await assert.rejects(() => handlers.create_scene({ name: 'L1' }), /not connected/i);
});

test('screenshot tool returns an image payload when online', async () => {
  const { handlers } = buildTools({ projects: mockProjects(), bridge: onlineBridge });
  const res = await handlers.screenshot({});
  assert.equal(typeof res, 'object');
  assert.ok(res.image.startsWith('data:image/png'));
});
