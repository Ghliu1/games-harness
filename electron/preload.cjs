// Preload: the only bridge between the sandboxed renderer and the main process.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

const EVENT_CHANNELS = [
  'agent:status',     // { state, label }
  'agent:text',       // { delta }
  'agent:tool',       // { name, input, phase, result, isError, image }
  'agent:error',      // { message }
  'project:files',    // file tree array
  'project:changed',  // { reason, file }
  'unity:status',     // { connected, status }
  'unity:logs',       // { logs: [...] }
];

contextBridge.exposeInMainWorld('gameforge', {
  agent: {
    isConfigured: () => invoke('agent:configured'),
    setApiKey: (key) => invoke('agent:setKey', key),
    send: (message) => invoke('agent:send', message),
    reset: () => invoke('agent:reset'),
  },
  project: {
    list: () => invoke('project:list'),
    active: () => invoke('project:active'),
    files: () => invoke('project:files'),
    open: (name) => invoke('project:open', name),
    create: (name, location) => invoke('project:create', { name, location }),
    addExisting: (p, name) => invoke('project:addExisting', { path: p, name }),
  },
  file: {
    read: (relPath) => invoke('file:read', relPath),
    write: (relPath, content) => invoke('file:write', { path: relPath, content }),
  },
  unity: {
    status: () => invoke('unity:status'),
    screenshot: () => invoke('unity:screenshot'),
    play: () => invoke('unity:play'),
    stop: () => invoke('unity:stop'),
  },
  dialog: {
    pickDirectory: (title) => invoke('dialog:pickDirectory', title),
  },
  on: (channel, handler) => {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error(`Unknown event channel: ${channel}`);
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
