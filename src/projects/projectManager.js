// ProjectManager — tracks the Unity projects GameForge knows about, manages the
// active one, installs the in-editor bridge package, watches the project's
// Assets for changes, and provides scoped, safe file access.
//
// A "project" is a reference to a Unity project folder anywhere on disk
// (it must contain an `Assets/` directory). Known projects are remembered in a
// small registry file so they reappear across launches.

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';

// Large/generated Unity folders we never list, watch, or copy.
const IGNORED = new Set([
  'Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds', 'UserSettings',
  '.git', '.vs', '.idea', 'node_modules', '.DS_Store',
]);

export class ProjectManager {
  constructor({ registryPath, bridgeSourceDir, starterDir, watch = true }) {
    this.registryPath = registryPath;
    this.bridgeSourceDir = bridgeSourceDir; // unity-bridge/  (C# editor package)
    this.starterDir = starterDir;           // optional starter C# scripts
    this.watch = watch;                     // disable in tests/headless contexts
    this.active = null;                     // { name, path }
    this.watcher = null;
    this._changeHandlers = new Set();
    this._registry = [];                    // [{ name, path }]
  }

  async init() {
    await this._loadRegistry();
    const valid = this._registry.filter((p) => isUnityProject(p.path));
    if (valid.length) await this.open(valid[0].name).catch(() => {});
  }

  onChange(handler) {
    this._changeHandlers.add(handler);
    return () => this._changeHandlers.delete(handler);
  }

  _notify(info) {
    for (const h of this._changeHandlers) {
      try { h(info); } catch {}
    }
  }

  // ---- registry -----------------------------------------------------------
  async _loadRegistry() {
    try {
      this._registry = JSON.parse(await fs.readFile(this.registryPath, 'utf-8'));
      if (!Array.isArray(this._registry)) this._registry = [];
    } catch {
      this._registry = [];
    }
  }

  async _saveRegistry() {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
    await fs.writeFile(this.registryPath, JSON.stringify(this._registry, null, 2));
  }

  _register(name, projectPath) {
    const existing = this._registry.find((p) => p.path === projectPath);
    if (existing) existing.name = name;
    else this._registry.push({ name, path: projectPath });
    return this._saveRegistry();
  }

  // ---- queries ------------------------------------------------------------
  list() {
    return this._registry.map((p) => ({
      name: p.name,
      path: p.path,
      exists: isUnityProject(p.path),
      active: this.active?.path === p.path,
    }));
  }

  activeProjectPath() {
    return this.active ? this.active.path : null;
  }

  activeSummary() {
    if (!this.active) return null;
    return { name: this.active.name, path: this.active.path };
  }

  // ---- lifecycle ----------------------------------------------------------

  /**
   * Scaffold a brand-new minimal Unity project at `location/name`. Unity Hub
   * (or the editor) will flesh out ProjectSettings on first open; we lay down
   * Assets/, Packages/manifest.json, a version hint, and the bridge.
   */
  async create(name, location) {
    const safe = sanitizeName(name);
    if (!safe) throw new Error('Invalid project name');
    if (!location) throw new Error('Choose a folder to create the project in');
    const dest = path.join(location, safe);
    if (fssync.existsSync(dest)) throw new Error(`"${safe}" already exists at that location`);

    await fs.mkdir(path.join(dest, 'Assets', 'Scenes'), { recursive: true });
    await fs.mkdir(path.join(dest, 'Packages'), { recursive: true });
    await fs.mkdir(path.join(dest, 'ProjectSettings'), { recursive: true });

    await fs.writeFile(
      path.join(dest, 'Packages', 'manifest.json'),
      JSON.stringify(
        { dependencies: { 'com.unity.modules.imgui': '1.0.0', 'com.unity.modules.ui': '1.0.0' } },
        null,
        2,
      ),
    );
    // Hint for Unity Hub; the editor rewrites this to the exact installed version.
    await fs.writeFile(
      path.join(dest, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: 2022.3.0f1\n',
    );

    await this._installBridge(dest);
    await this._installStarters(dest);
    await this._register(safe, dest);
    await this.open(safe);
    return this.activeSummary();
  }

  /** Add an existing Unity project folder to the registry and open it. */
  async addExisting(projectPath, displayName) {
    if (!isUnityProject(projectPath)) {
      throw new Error('That folder is not a Unity project (no Assets/ directory found).');
    }
    const name = sanitizeName(displayName || path.basename(projectPath));
    await this._installBridge(projectPath);
    await this._register(name, projectPath);
    return this.open(name);
  }

  async open(name) {
    const entry = this._registry.find((p) => p.name === name) || { name, path: name };
    const projectPath = entry.path;
    if (!isUnityProject(projectPath)) {
      throw new Error(`Not a Unity project: ${projectPath}`);
    }
    // Keep the bridge up to date every time we open.
    await this._installBridge(projectPath).catch(() => {});
    this.active = { name: entry.name, path: projectPath };
    this._startWatching();
    this._notify({ reason: 'open', name: entry.name });
    return this.activeSummary();
  }

  /** Copy the GameForge bridge editor package into <project>/Assets/GameForge. */
  async _installBridge(projectPath) {
    if (!this.bridgeSourceDir || !fssync.existsSync(this.bridgeSourceDir)) return;
    const dest = path.join(projectPath, 'Assets', 'GameForge');
    await copyDir(this.bridgeSourceDir, dest);
  }

  async _installStarters(projectPath) {
    if (!this.starterDir || !fssync.existsSync(this.starterDir)) return;
    const dest = path.join(projectPath, 'Assets', 'Scripts');
    await copyDir(this.starterDir, dest);
  }

  _startWatching() {
    if (this.watcher) this.watcher.close();
    if (!this.active || !this.watch) return;
    const assetsDir = path.join(this.active.path, 'Assets');
    this.watcher = chokidar.watch(assetsDir, {
      ignoreInitial: true,
      ignored: (p) => IGNORED.has(path.basename(p)) || p.endsWith('.meta'),
    });
    const trigger = (reason) => (p) =>
      this._notify({ reason, file: path.relative(this.active.path, p) });
    this.watcher
      .on('add', trigger('add'))
      .on('change', trigger('change'))
      .on('unlink', trigger('unlink'));
  }

  // ---- scoped file access -------------------------------------------------
  _resolve(relPath) {
    if (!this.active) throw new Error('No active project');
    const clean = String(relPath).replace(/^[/\\]+/, '');
    const full = path.resolve(this.active.path, clean);
    if (full !== this.active.path && !full.startsWith(this.active.path + path.sep)) {
      throw new Error(`Path escapes project: ${relPath}`);
    }
    return full;
  }

  async readFile(relPath) {
    return fs.readFile(this._resolve(relPath), 'utf-8');
  }

  async writeFile(relPath, content) {
    const full = this._resolve(relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }

  async deleteFile(relPath) {
    await fs.rm(this._resolve(relPath), { recursive: true, force: true });
  }

  async listFiles() {
    if (!this.active) return [];
    // Scope listings to Assets — the part of the project users and AI edit.
    const assets = path.join(this.active.path, 'Assets');
    if (!fssync.existsSync(assets)) return [];
    return walk(assets, this.active.path);
  }

  fileTree() {
    if (!this.active) return [];
    const assets = path.join(this.active.path, 'Assets');
    if (!fssync.existsSync(assets)) return [];
    return [{ type: 'dir', name: 'Assets', path: 'Assets', children: buildTreeSync(assets, this.active.path) }];
  }

  dispose() {
    if (this.watcher) this.watcher.close();
  }
}

// ---- helpers --------------------------------------------------------------
function isUnityProject(p) {
  try {
    return Boolean(p) && fssync.statSync(path.join(p, 'Assets')).isDirectory();
  } catch {
    return false;
  }
}

function sanitizeName(name) {
  return String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 64);
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

async function walk(dir, root) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (IGNORED.has(e.name) || e.name.endsWith('.meta')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, root)));
    else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

function buildTreeSync(dir, root) {
  const nodes = [];
  let entries = [];
  try {
    entries = fssync.readdirSync(dir, { withFileTypes: true });
  } catch {
    return nodes;
  }
  for (const e of entries.sort(sortEntries)) {
    if (IGNORED.has(e.name) || e.name.endsWith('.meta')) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      nodes.push({ type: 'dir', name: e.name, path: rel, children: buildTreeSync(full, root) });
    } else {
      nodes.push({ type: 'file', name: e.name, path: rel });
    }
  }
  return nodes;
}

function sortEntries(a, b) {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name);
}
