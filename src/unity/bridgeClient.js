// UnityBridgeClient — talks to the GameForge bridge running *inside* the Unity
// Editor over local HTTP. The bridge (C# editor scripts under
// Assets/GameForge/Editor) exposes:
//
//   GET  /ping            -> editor status (version, project, isPlaying, …)
//   POST /rpc             -> run a single editor command on Unity's main thread
//   GET  /logs?since=N    -> incremental console log entries
//   GET  /screenshot      -> PNG capture of the Game view
//
// The harness never controls Unity directly; it asks the in-editor bridge to
// act, so everything happens through Unity's real editor API.

const DEFAULT_PORT = Number(process.env.GAMEFORGE_BRIDGE_PORT || 17890);

export class UnityBridgeClient {
  constructor({ port = DEFAULT_PORT } = {}) {
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
    this.connected = false;
    this.lastStatus = null;
  }

  async _fetch(path, opts = {}, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.base + path, { ...opts, signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Cheap liveness/status check. Updates `connected` and returns status or null. */
  async ping() {
    try {
      const res = await this._fetch('/ping', {}, 2500);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const status = await res.json();
      this.connected = true;
      this.lastStatus = status;
      return status;
    } catch {
      this.connected = false;
      return null;
    }
  }

  /**
   * Invoke an editor command. Resolves with the command's `result`, or throws
   * with the bridge-reported error message.
   */
  async rpc(method, params = {}, timeoutMs = 60000) {
    const res = await this._fetch(
      '/rpc',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, ...params }),
      },
      timeoutMs,
    );
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Bridge returned non-JSON for ${method}`);
    }
    if (!data || data.ok === false) {
      throw new Error(data?.error || `Command "${method}" failed`);
    }
    return data.result;
  }

  /** Fetch console log entries newer than `since` (a monotonic id). */
  async logs(since = 0) {
    try {
      const res = await this._fetch(`/logs?since=${since}`, {}, 5000);
      if (!res.ok) return { logs: [], next: since };
      return await res.json();
    } catch {
      return { logs: [], next: since };
    }
  }

  /** Capture the Game view as a PNG data URL, or null if unavailable. */
  async screenshot() {
    try {
      const res = await this._fetch('/screenshot', {}, 15000);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return null;
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  }
}
