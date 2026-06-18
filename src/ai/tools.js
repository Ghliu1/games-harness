// Tools handed to Claude for building Unity games.
//
// Two families:
//   * File tools — create/read/edit C# scripts, shaders, configs, JSON, etc.
//     inside the active Unity project (scoped to its Assets folder).
//   * Unity tools — RPCs into the live Unity Editor via the bridge: build
//     scenes, spawn GameObjects, attach scripts/components, set properties,
//     make materials/prefabs, enter play mode, and capture the Game view.
//
// A handler may return a plain string, or `{ text, image }` where `image` is a
// PNG data URL — the agent forwards images to Claude as visual tool results so
// it can literally see the running game.

export function buildTools({ projects, bridge }) {
  const requireUnity = async () => {
    const status = await bridge.ping();
    if (!status) {
      throw new Error(
        'Unity is not connected. Open the project in the Unity Editor so the GameForge bridge can start, then retry.',
      );
    }
    return status;
  };

  const tools = [
    // ---------------------------------------------------------------- files
    {
      name: 'list_files',
      description: 'List every file under the project Assets/ folder (relative paths). Orient yourself here first.',
      input_schema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const files = await projects.listFiles();
        return files.length ? files.join('\n') : '(Assets is empty)';
      },
    },
    {
      name: 'read_file',
      description: 'Read a text file (C# script, json, shader, …) from the project.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Project-relative path, e.g. "Assets/Scripts/Player.cs".' } },
        required: ['path'],
      },
      handler: async ({ path }) => {
        try { return await projects.readFile(path); }
        catch (e) { return `ERROR: ${e.message}`; }
      },
    },
    {
      name: 'write_file',
      description:
        'Create or overwrite a text file. Use for C# MonoBehaviour scripts, ScriptableObjects, shaders, JSON data, etc. After writing scripts, call refresh_assets so Unity recompiles.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'e.g. "Assets/Scripts/PlayerController.cs".' },
          content: { type: 'string', description: 'Full file contents.' },
        },
        required: ['path', 'content'],
      },
      handler: async ({ path, content }) => {
        await projects.writeFile(path, content);
        return `Wrote ${path} (${content.length} bytes). Call refresh_assets to recompile if this was a script.`;
      },
    },
    {
      name: 'apply_edit',
      description: 'Make a targeted edit by replacing an exact, unique substring in a file. Prefer over full rewrites for small changes.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          find: { type: 'string', description: 'Exact text to locate (must be unique in the file).' },
          replace: { type: 'string' },
        },
        required: ['path', 'find', 'replace'],
      },
      handler: async ({ path, find, replace }) => {
        let content;
        try { content = await projects.readFile(path); }
        catch (e) { return `ERROR: cannot read ${path}: ${e.message}`; }
        const count = content.split(find).length - 1;
        if (count === 0) return `ERROR: "find" text not found in ${path}.`;
        if (count > 1) return `ERROR: "find" appears ${count} times; make it unique.`;
        await projects.writeFile(path, content.replace(find, replace));
        return `Edited ${path}.`;
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a file or folder from the project Assets.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async ({ path }) => { await projects.deleteFile(path); return `Deleted ${path}.`; },
    },

    // ---------------------------------------------------------------- unity
    {
      name: 'unity_status',
      description: 'Check whether the Unity Editor bridge is connected and report editor/project/play state.',
      input_schema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const s = await bridge.ping();
        return s ? JSON.stringify(s) : 'Unity is NOT connected. Open the project in the Unity Editor.';
      },
    },
    {
      name: 'refresh_assets',
      description: 'Tell Unity to import new/changed assets and recompile scripts. Call after writing or editing C# files. Returns any compile errors.',
      input_schema: { type: 'object', properties: {}, required: [] },
      handler: async () => { await requireUnity(); return await bridge.rpc('refresh', {}, 120000); },
    },
    {
      name: 'create_scene',
      description: 'Create a new empty scene, save it under Assets/Scenes, and make it the active scene.',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Scene name without extension, e.g. "Level1".' } },
        required: ['name'],
      },
      handler: async ({ name }) => { await requireUnity(); return await bridge.rpc('createScene', { name }); },
    },
    {
      name: 'open_scene',
      description: 'Open an existing scene by asset path, e.g. "Assets/Scenes/Level1.unity".',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async ({ path }) => { await requireUnity(); return await bridge.rpc('openScene', { path }); },
    },
    {
      name: 'save_scene',
      description: 'Save the active scene to disk.',
      input_schema: { type: 'object', properties: {}, required: [] },
      handler: async () => { await requireUnity(); return await bridge.rpc('saveScene', {}); },
    },
    {
      name: 'list_hierarchy',
      description: 'List the GameObjects in the active scene as a hierarchy (names and paths). Use to find targets for other commands.',
      input_schema: { type: 'object', properties: {}, required: [] },
      handler: async () => { await requireUnity(); return await bridge.rpc('listHierarchy', {}); },
    },
    {
      name: 'create_gameobject',
      description:
        'Create a GameObject in the active scene. Optionally make it a primitive (Cube, Sphere, Capsule, Cylinder, Plane, Quad), parent it, and set transform. Returns its hierarchy path to use as a target.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          primitive: { type: 'string', enum: ['Cube', 'Sphere', 'Capsule', 'Cylinder', 'Plane', 'Quad'] },
          parent: { type: 'string', description: 'Optional parent hierarchy path.' },
          position: { type: 'array', items: { type: 'number' }, description: '[x,y,z]' },
          rotation: { type: 'array', items: { type: 'number' }, description: 'Euler [x,y,z]' },
          scale: { type: 'array', items: { type: 'number' }, description: '[x,y,z]' },
        },
        required: ['name'],
      },
      handler: async (input) => { await requireUnity(); return await bridge.rpc('createGameObject', input); },
    },
    {
      name: 'set_transform',
      description: 'Set position/rotation/scale of a GameObject (by hierarchy path or name).',
      input_schema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          position: { type: 'array', items: { type: 'number' } },
          rotation: { type: 'array', items: { type: 'number' } },
          scale: { type: 'array', items: { type: 'number' } },
        },
        required: ['target'],
      },
      handler: async (input) => { await requireUnity(); return await bridge.rpc('setTransform', input); },
    },
    {
      name: 'add_component',
      description:
        'Add a built-in Unity component to a GameObject by type name, e.g. "Rigidbody", "BoxCollider", "Light", "Camera", "AudioSource".',
      input_schema: {
        type: 'object',
        properties: { target: { type: 'string' }, type: { type: 'string' } },
        required: ['target', 'type'],
      },
      handler: async (input) => { await requireUnity(); return await bridge.rpc('addComponent', input); },
    },
    {
      name: 'attach_script',
      description:
        'Attach a user MonoBehaviour script (by its class name) to a GameObject. The script must already exist and have compiled (write_file + refresh_assets first).',
      input_schema: {
        type: 'object',
        properties: { target: { type: 'string' }, scriptName: { type: 'string', description: 'C# class name.' } },
        required: ['target', 'scriptName'],
      },
      handler: async (input) => { await requireUnity(); return await bridge.rpc('attachScript', input); },
    },
    {
      name: 'set_property',
      description:
        'Set a serialized property on a component of a GameObject. Value is parsed to match the field type (number, bool, string, or "x,y,z" for vectors/colors). Example: target "Player", component "Rigidbody", property "mass", value "2".',
      input_schema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          component: { type: 'string' },
          property: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['target', 'component', 'property', 'value'],
      },
      handler: async (input) => { await requireUnity(); return await bridge.rpc('setProperty', input); },
    },
    {
      name: 'delete_gameobject',
      description: 'Delete a GameObject from the active scene.',
      input_schema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
      handler: async (input) => { await requireUnity(); return await bridge.rpc('deleteGameObject', input); },
    },
    {
      name: 'create_material',
      description: 'Create a material asset. Optionally set a base color "r,g,b" or "r,g,b,a" (0-1) and a shader name (defaults to a standard URP/Standard lit shader).',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'e.g. "Assets/Materials/Red.mat".' },
          color: { type: 'string' },
          shader: { type: 'string' },
        },
        required: ['path'],
      },
      handler: async (input) => { await requireUnity(); return await bridge.rpc('createMaterial', input); },
    },
    {
      name: 'assign_material',
      description: 'Assign a material asset to a GameObject\'s renderer.',
      input_schema: {
        type: 'object',
        properties: { target: { type: 'string' }, materialPath: { type: 'string' } },
        required: ['target', 'materialPath'],
      },
      handler: async (input) => { await requireUnity(); return await bridge.rpc('assignMaterial', input); },
    },
    {
      name: 'create_prefab',
      description: 'Save a GameObject in the scene as a reusable prefab asset.',
      input_schema: {
        type: 'object',
        properties: { target: { type: 'string' }, path: { type: 'string', description: 'e.g. "Assets/Prefabs/Enemy.prefab".' } },
        required: ['target', 'path'],
      },
      handler: async (input) => { await requireUnity(); return await bridge.rpc('createPrefab', input); },
    },
    {
      name: 'instantiate_prefab',
      description: 'Instantiate a prefab asset into the active scene at an optional position.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' }, position: { type: 'array', items: { type: 'number' } } },
        required: ['path'],
      },
      handler: async (input) => { await requireUnity(); return await bridge.rpc('instantiatePrefab', input); },
    },
    {
      name: 'enter_play_mode',
      description: 'Enter Play mode to run the game in the Unity Editor.',
      input_schema: { type: 'object', properties: {}, required: [] },
      handler: async () => { await requireUnity(); return await bridge.rpc('enterPlayMode', {}); },
    },
    {
      name: 'exit_play_mode',
      description: 'Exit Play mode and return to editing.',
      input_schema: { type: 'object', properties: {}, required: [] },
      handler: async () => { await requireUnity(); return await bridge.rpc('exitPlayMode', {}); },
    },
    {
      name: 'screenshot',
      description:
        'Capture the Unity Game view and SEE the result. Use to verify visuals, check scene composition, or watch the running game. Works in both edit and play mode.',
      input_schema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        await requireUnity();
        const dataUrl = await bridge.screenshot();
        if (!dataUrl) return 'No screenshot available (the Game view may be empty or the editor is busy).';
        return { text: 'Captured the Unity Game view:', image: dataUrl };
      },
    },
    {
      name: 'get_console',
      description: 'Read recent Unity console log entries (logs, warnings, errors). Use to diagnose runtime or compile problems.',
      input_schema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        await requireUnity();
        const { logs } = await bridge.logs(0);
        if (!logs || !logs.length) return '(console is empty)';
        return logs.slice(-40).map((l) => `[${l.type}] ${l.message}`).join('\n');
      },
    },
  ];

  const schemas = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  const handlers = Object.fromEntries(tools.map((t) => [t.name, t.handler]));
  return { schemas, handlers };
}
