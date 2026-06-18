# 🎮 GameForge — build Unity games with Claude

GameForge is a desktop harness that lets you build **real Unity games** by chatting
with Claude. You describe what you want; Claude writes the C# scripts, builds scenes,
spawns and configures GameObjects, creates materials and prefabs, enters play mode,
and **screenshots the Game view to see and verify its own work** — all through Unity's
real editor API.

It is an Electron app on top of two pieces:

- **The harness app** — chat with Claude, browse the project's files, watch the Unity
  console, and see live Game-view screenshots.
- **The Unity bridge** — a small C# editor package GameForge installs into your project
  (`Assets/GameForge/`). It runs a local HTTP server inside the Unity Editor so the
  harness (and Claude) can drive the editor live.

```
┌──────────────┐   tools/RPC    ┌──────────────┐   HTTP (localhost)   ┌────────────────┐
│    Claude    │ ─────────────► │ GameForge app │ ───────────────────► │  Unity Editor  │
│  (Anthropic) │ ◄───────────── │  (Electron)   │ ◄─────────────────── │ + GameForge    │
└──────────────┘  text + images └──────────────┘  status/logs/PNG     │   bridge (C#)  │
                                                                       └────────────────┘
```

## Requirements

- **Node.js 20+**
- **Unity** (2021.3+ recommended; tested against 2022.3 LTS conventions), installed via
  [Unity Hub](https://unity.com/download).
- An **Anthropic API key** (`ANTHROPIC_API_KEY`).

## Quick start

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # or set it later in Settings
npm start
```

Then, in the app:

1. **New game** → pick a name and a folder. GameForge scaffolds a minimal Unity project
   and installs the bridge + starter scripts. (Or **Add existing** to point at a Unity
   project you already have.)
2. Open that project in **Unity Hub** (*Add → project on disk*) and open it in the editor.
   The bridge starts automatically — the app's `Unity: connected` pill turns on.
3. Start chatting: *"Make a 3D platformer: a player cube that moves with WASD and jumps,
   on a ground plane, with a follow camera. Then play it and show me."*

Claude will write scripts, build the scene, press Play, and screenshot the result.

## What Claude can do (its tools)

**Files** (scoped to the project's `Assets/`):
`list_files`, `read_file`, `write_file`, `apply_edit`, `delete_file`.

**Live Unity editor** (via the bridge):
`refresh_assets`, `create_scene` / `open_scene` / `save_scene`, `list_hierarchy`,
`create_gameobject`, `set_transform`, `add_component`, `attach_script`, `set_property`,
`delete_gameobject`, `create_material` / `assign_material`, `create_prefab` /
`instantiate_prefab`, `enter_play_mode` / `exit_play_mode`, `get_console`, and
`screenshot` (returned to Claude as an image so it can *see* the game).

## Project layout

```
electron/            Electron main process + preload (IPC bridge)
  main.js            Window, project mgmt, Unity polling, agent IPC
  preload.cjs        Safe renderer ↔ main API surface
renderer/            The desktop UI (chat, files, Unity view, console)
src/
  ai/                Claude agent: tool loop, tool defs, system prompt
  projects/          ProjectManager: registry, scoped file I/O, bridge install
  unity/             UnityBridgeClient: HTTP client for the in-editor bridge
unity-bridge/Editor/ The C# editor package installed into each Unity project
unity-starters/      Optional starter C# scripts copied into new projects
test/                Node test-runner unit tests
scripts/             Syntax-check gate
```

## How the bridge works

`unity-bridge/Editor/*.cs` is copied into your project at `Assets/GameForge/Editor/`.
On editor load it starts an `HttpListener` on `127.0.0.1:17890` (override with
`GAMEFORGE_BRIDGE_PORT`). Because Unity's API is main-thread-only, HTTP requests that
touch the editor are marshalled onto `EditorApplication.update` and the request thread
waits for the result. Endpoints: `/ping`, `/rpc`, `/logs`, `/screenshot`.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Claude API key | — (set in Settings) |
| `GAMEFORGE_MODEL` | Model id | `claude-opus-4-8` |
| `GAMEFORGE_BRIDGE_PORT` | Bridge port (app **and** Unity must match) | `17890` |
| `GAMEFORGE_DEVTOOLS` | Open Electron devtools when `1` | off |

## Develop

```bash
npm run lint   # parse-check all JS
npm test       # unit tests (project mgmt + tool layer)
npm start      # launch the app
```

## Notes & limitations

- The Unity Editor must be open with the project for live editor commands and play
  testing. When it isn't connected, Claude still authors/organizes scripts and tells you
  to open Unity.
- New-project scaffolding is intentionally minimal; Unity fleshes out `ProjectSettings`
  on first open. For a specific render pipeline (URP/HDRP) or template, create the project
  in Unity Hub and use **Add existing**.
- The screenshot path renders the active camera to a texture, so it works in both edit and
  play mode.

## License

MIT
