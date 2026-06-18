// Renderer: wires the UI to the main process through window.gameforge (preload).

const gf = window.gameforge;

const els = {
  projectSelect: document.getElementById('project-select'),
  newProject: document.getElementById('new-project'),
  addProject: document.getElementById('add-project'),
  unityPill: document.getElementById('unity-pill'),
  status: document.getElementById('agent-status'),
  fileTree: document.getElementById('file-tree'),
  unityShot: document.getElementById('unity-shot'),
  unityEmpty: document.getElementById('unity-empty'),
  playBtn: document.getElementById('play-btn'),
  stopBtn: document.getElementById('stop-btn'),
  shotBtn: document.getElementById('shot-btn'),
  consoleLog: document.getElementById('console-log'),
  chatLog: document.getElementById('chat-log'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  sendBtn: document.getElementById('send-btn'),
  resetChat: document.getElementById('reset-chat'),
  settingsBtn: document.getElementById('settings-btn'),
  // new project modal
  newModal: document.getElementById('new-modal'),
  newName: document.getElementById('new-name'),
  newLocation: document.getElementById('new-location'),
  newBrowse: document.getElementById('new-browse'),
  newCancel: document.getElementById('new-cancel'),
  newCreate: document.getElementById('new-create'),
  // settings modal
  settingsModal: document.getElementById('settings-modal'),
  apiKey: document.getElementById('api-key'),
  settingsCancel: document.getElementById('settings-cancel'),
  settingsSave: document.getElementById('settings-save'),
};

let currentAssistantEl = null;
let unityConnected = false;

init().catch((e) => logConsole(String(e), 'err'));

async function init() {
  await refreshProjects();
  await refreshFiles();
  subscribeEvents();
  if (!(await gf.agent.isConfigured())) openSettings();
}

function subscribeEvents() {
  gf.on('project:files', (tree) => renderTree(tree));
  gf.on('agent:status', ({ state, label }) => setStatus(state, label));
  gf.on('agent:text', ({ delta }) => appendAssistant(delta));
  gf.on('agent:tool', (info) => renderToolActivity(info));
  gf.on('agent:error', ({ message }) => { addChat('assistant', `⚠️ ${message}`); setStatus('error', 'Error'); });

  gf.on('unity:status', ({ connected }) => setUnity(connected));
  gf.on('unity:logs', ({ logs }) => logs.forEach((l) => logConsole(`[${l.type}] ${l.message}`, l.type === 'Error' ? 'err' : '')));
}

// ---- projects --------------------------------------------------------------
async function refreshProjects() {
  const list = await gf.project.list();
  const active = await gf.project.active();
  els.projectSelect.innerHTML = '';
  if (!list.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No projects yet';
    opt.disabled = true;
    els.projectSelect.appendChild(opt);
  }
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = (p.exists ? '' : '⚠ ') + p.name;
    if (active && active.name === p.name) opt.selected = true;
    els.projectSelect.appendChild(opt);
  }
}

els.projectSelect.addEventListener('change', async (e) => {
  try {
    await gf.project.open(e.target.value);
    await refreshFiles();
    logConsole(`Opened ${e.target.value}.`, 'ok');
  } catch (err) { logConsole(String(err.message || err), 'err'); }
});

els.addProject.addEventListener('click', async () => {
  const dir = await gf.dialog.pickDirectory('Select an existing Unity project folder');
  if (!dir) return;
  try {
    await gf.project.addExisting(dir);
    await refreshProjects();
    await refreshFiles();
    logConsole(`Added project from ${dir}.`, 'ok');
  } catch (err) { logConsole(String(err.message || err), 'err'); }
});

// ---- files -----------------------------------------------------------------
async function refreshFiles() {
  renderTree(await gf.project.files());
}

function renderTree(nodes) {
  els.fileTree.innerHTML = '';
  els.fileTree.appendChild(buildTreeEl(nodes));
}

function buildTreeEl(nodes) {
  const frag = document.createDocumentFragment();
  for (const node of nodes || []) {
    const el = document.createElement('div');
    el.className = `tree-node ${node.type}`;
    el.textContent = (node.type === 'dir' ? '📁 ' : '📄 ') + node.name;
    frag.appendChild(el);
    if (node.type === 'dir' && node.children?.length) {
      const wrap = document.createElement('div');
      wrap.className = 'tree-children';
      wrap.appendChild(buildTreeEl(node.children));
      frag.appendChild(wrap);
    }
  }
  return frag;
}

// ---- unity view ------------------------------------------------------------
function setUnity(connected) {
  unityConnected = connected;
  els.unityPill.className = `status ${connected ? 'tool' : 'idle'}`;
  els.unityPill.textContent = connected ? 'Unity: connected' : 'Unity: offline';
  els.unityEmpty.style.display = connected && els.unityShot.src ? 'none' : 'flex';
  if (connected) captureShot();
}

async function captureShot() {
  const dataUrl = await gf.unity.screenshot();
  if (dataUrl) {
    els.unityShot.src = dataUrl;
    els.unityShot.style.display = 'block';
    els.unityEmpty.style.display = 'none';
  }
}

els.shotBtn.addEventListener('click', captureShot);
els.playBtn.addEventListener('click', async () => { await gf.unity.play(); setTimeout(captureShot, 800); });
els.stopBtn.addEventListener('click', async () => { await gf.unity.stop(); setTimeout(captureShot, 400); });

// ---- chat ------------------------------------------------------------------
els.chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
els.chatInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendMessage(); }
});
els.resetChat.addEventListener('click', async () => {
  await gf.agent.reset();
  els.chatLog.innerHTML = '';
  logConsole('Started a new chat.', '');
});

async function sendMessage() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  els.chatInput.value = '';
  addChat('user', text);
  currentAssistantEl = null;
  els.sendBtn.disabled = true;
  const res = await gf.agent.send(text);
  els.sendBtn.disabled = false;
  setStatus('idle', 'Ready');
  if (res && res.ok === false) addChat('assistant', `⚠️ ${res.error}`);
  if (unityConnected) captureShot();
}

function addChat(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  els.chatLog.appendChild(el);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
  return el;
}

function appendAssistant(delta) {
  if (!currentAssistantEl) currentAssistantEl = addChat('assistant', '');
  currentAssistantEl.textContent += delta;
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function renderToolActivity({ name, input, phase, image }) {
  if (phase === 'start') {
    const el = document.createElement('div');
    el.className = 'msg tool';
    el.innerHTML = `<b>⚙ ${name}</b> ${describeTool(input)}`;
    els.chatLog.appendChild(el);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
    currentAssistantEl = null;
  } else if (phase === 'done' && image) {
    // Show screenshots the agent captured inline, and update the Unity view.
    els.unityShot.src = image;
    els.unityShot.style.display = 'block';
    els.unityEmpty.style.display = 'none';
  }
}

function describeTool(input) {
  if (!input) return '';
  return input.path || input.target || input.name || '';
}

// ---- status & console ------------------------------------------------------
function setStatus(state, label) {
  els.status.className = `status ${state || 'idle'}`;
  els.status.textContent = label || (state === 'idle' ? 'Ready' : state);
}

function logConsole(text, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  els.consoleLog.appendChild(line);
  while (els.consoleLog.childElementCount > 500) els.consoleLog.removeChild(els.consoleLog.firstChild);
  els.consoleLog.scrollTop = els.consoleLog.scrollHeight;
}

// ---- new project modal -----------------------------------------------------
els.newProject.addEventListener('click', () => {
  els.newName.value = '';
  els.newLocation.value = '';
  els.newModal.classList.remove('hidden');
  els.newName.focus();
});
els.newBrowse.addEventListener('click', async () => {
  const dir = await gf.dialog.pickDirectory('Choose where to create the project');
  if (dir) els.newLocation.value = dir;
});
els.newCancel.addEventListener('click', () => els.newModal.classList.add('hidden'));
els.newCreate.addEventListener('click', async () => {
  const name = els.newName.value.trim();
  const location = els.newLocation.value.trim();
  if (!name) return els.newName.focus();
  if (!location) return els.newBrowse.focus();
  try {
    await gf.project.create(name, location);
    els.newModal.classList.add('hidden');
    await refreshProjects();
    await refreshFiles();
    logConsole(`Created "${name}". Open it in Unity Hub to start the bridge.`, 'ok');
  } catch (e) { logConsole(String(e.message || e), 'err'); }
});

// ---- settings modal --------------------------------------------------------
els.settingsBtn.addEventListener('click', openSettings);
function openSettings() { els.settingsModal.classList.remove('hidden'); els.apiKey.focus(); }
els.settingsCancel.addEventListener('click', () => els.settingsModal.classList.add('hidden'));
els.settingsSave.addEventListener('click', async () => {
  const key = els.apiKey.value.trim();
  if (key) {
    const ok = await gf.agent.setApiKey(key);
    logConsole(ok ? 'API key set.' : 'API key rejected.', ok ? 'ok' : 'err');
  }
  els.settingsModal.classList.add('hidden');
});
