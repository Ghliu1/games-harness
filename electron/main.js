// GameForge — Electron main process (Unity edition).
//
// Responsibilities:
//   * Create the desktop window (chat + project files + Unity view + console).
//   * Manage Unity projects (a registry of project folders on disk) and install
//     the GameForge editor bridge package into each one.
//   * Talk to the live Unity Editor through the bridge client: poll status,
//     stream console logs, capture Game-view screenshots, run editor commands.
//   * Run the Claude agent loop and relay its progress to the renderer.

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ProjectManager } from '../src/projects/projectManager.js';
import { UnityBridgeClient } from '../src/unity/bridgeClient.js';
import { GameAgent } from '../src/ai/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let mainWindow = null;
let projects = null;
let bridge = null;
let agent = null;
let pollTimer = null;
let lastLogId = 0;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#13141b',
    title: 'GameForge — Unity',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  if (process.env.GAMEFORGE_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function bootstrap() {
  const configDir = path.join(ROOT, 'config');
  await fs.mkdir(configDir, { recursive: true });

  projects = new ProjectManager({
    registryPath: path.join(configDir, 'projects.json'),
    bridgeSourceDir: path.join(ROOT, 'unity-bridge'),
    starterDir: path.join(ROOT, 'unity-starters'),
  });
  await projects.init();

  bridge = new UnityBridgeClient();

  projects.onChange((info) => {
    emit('project:files', projects.fileTree());
    emit('project:changed', info);
  });

  agent = new GameAgent({ apiKey: process.env.ANTHROPIC_API_KEY, projects, bridge, emit });

  registerIpc();
  startPolling();
}

// Poll the Unity bridge for connection status and console logs.
function startPolling() {
  const tick = async () => {
    const status = await bridge.ping();
    emit('unity:status', { connected: Boolean(status), status });
    if (status) {
      const { logs, next } = await bridge.logs(lastLogId);
      if (logs && logs.length) {
        lastLogId = next ?? lastLogId;
        emit('unity:logs', { logs });
      }
    }
  };
  tick();
  pollTimer = setInterval(tick, 2000);
}

function registerIpc() {
  // ---- agent --------------------------------------------------------------
  ipcMain.handle('agent:configured', () => agent.isConfigured());
  ipcMain.handle('agent:setKey', (_e, key) => { agent.setApiKey(key); return agent.isConfigured(); });
  ipcMain.handle('agent:reset', () => agent.resetConversation());
  ipcMain.handle('agent:send', async (_e, message) => {
    try { return await agent.send(message); }
    catch (err) {
      emit('agent:error', { message: String(err?.message || err) });
      return { ok: false, error: String(err?.message || err) };
    }
  });

  // ---- projects -----------------------------------------------------------
  ipcMain.handle('project:list', () => projects.list());
  ipcMain.handle('project:active', () => projects.activeSummary());
  ipcMain.handle('project:files', () => projects.fileTree());

  ipcMain.handle('project:open', async (_e, name) => {
    const opened = await projects.open(name);
    emit('project:files', projects.fileTree());
    return opened;
  });

  ipcMain.handle('project:create', async (_e, { name, location }) => {
    const created = await projects.create(name, location);
    emit('project:files', projects.fileTree());
    return created;
  });

  ipcMain.handle('project:addExisting', async (_e, { path: p, name }) => {
    const opened = await projects.addExisting(p, name);
    emit('project:files', projects.fileTree());
    return opened;
  });

  ipcMain.handle('dialog:pickDirectory', async (_e, title) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });

  // ---- files --------------------------------------------------------------
  ipcMain.handle('file:read', (_e, relPath) => projects.readFile(relPath));
  ipcMain.handle('file:write', async (_e, { path: relPath, content }) => {
    await projects.writeFile(relPath, content);
    return { ok: true };
  });

  // ---- unity --------------------------------------------------------------
  ipcMain.handle('unity:status', () => bridge.ping());
  ipcMain.handle('unity:screenshot', () => bridge.screenshot());
  ipcMain.handle('unity:play', () => bridge.rpc('enterPlayMode', {}).catch((e) => ({ error: String(e.message) })));
  ipcMain.handle('unity:stop', () => bridge.rpc('exitPlayMode', {}).catch((e) => ({ error: String(e.message) })));
}

app.whenReady().then(async () => {
  await bootstrap();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (projects) projects.dispose();
  if (process.platform !== 'darwin') app.quit();
});
