// GameAgent — drives a Claude conversation with the Unity game-building tool
// loop. Each `send()` runs a full agentic turn: the model may call tools
// (write C# scripts, drive the Unity Editor, screenshot the Game view, …)
// repeatedly until it produces a final reply. Progress streams to the renderer
// via the `emit` callback. Tools may return images so Claude can see the game.

import Anthropic from '@anthropic-ai/sdk';
import { buildTools } from './tools.js';
import { buildSystemPrompt } from './systemPrompt.js';

const MODEL = process.env.GAMEFORGE_MODEL || 'claude-opus-4-8';
const MAX_TOOL_ROUNDS = 32;

export class GameAgent {
  constructor({ apiKey, projects, bridge, emit }) {
    this.projects = projects;
    this.bridge = bridge;
    this.emit = emit || (() => {});
    this.history = [];
    this.client = null;
    if (apiKey) this.setApiKey(apiKey);

    const { schemas, handlers } = buildTools({ projects, bridge });
    this.toolSchemas = schemas;
    this.toolHandlers = handlers;
  }

  setApiKey(key) {
    this.apiKey = key;
    this.client = key ? new Anthropic({ apiKey: key }) : null;
  }

  isConfigured() {
    return Boolean(this.client);
  }

  resetConversation() {
    this.history = [];
    return { ok: true };
  }

  async send(userMessage) {
    if (!this.client) throw new Error('No Anthropic API key configured. Add your key in Settings.');
    if (!this.projects.active) throw new Error('Open or create a Unity project first.');

    this.history.push({ role: 'user', content: userMessage });

    const files = await this.projects.listFiles();
    const unity = await this.bridge.ping();
    const system = buildSystemPrompt({
      projectName: this.projects.active.name,
      files,
      unityConnected: Boolean(unity),
      unityStatus: unity,
    });

    let finalText = '';

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      this.emit('agent:status', { state: 'thinking', label: 'Claude is thinking…' });

      const stream = this.client.messages.stream({
        model: MODEL,
        max_tokens: 8000,
        system,
        tools: this.toolSchemas,
        messages: this.history,
      });

      stream.on('text', (delta) => {
        finalText += delta;
        this.emit('agent:text', { delta });
      });

      const response = await stream.finalMessage();
      this.history.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0 || response.stop_reason !== 'tool_use') {
        this.emit('agent:status', { state: 'idle' });
        return { ok: true, text: textOf(response) };
      }

      const toolResults = [];
      for (const call of toolUses) {
        this.emit('agent:tool', { name: call.name, input: call.input, phase: 'start' });
        this.emit('agent:status', { state: 'tool', label: `Running ${call.name}…` });

        let raw;
        let isError = false;
        try {
          const handler = this.toolHandlers[call.name];
          if (!handler) throw new Error(`Unknown tool: ${call.name}`);
          raw = await handler(call.input || {});
        } catch (err) {
          raw = `ERROR: ${err.message}`;
          isError = true;
        }

        const { content, display } = formatToolResult(raw);
        this.emit('agent:tool', { name: call.name, input: call.input, phase: 'done', result: display, isError, image: imageOf(raw) });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content,
          is_error: isError,
        });
      }

      this.history.push({ role: 'user', content: toolResults });
    }

    this.emit('agent:status', { state: 'idle' });
    this.emit('agent:error', { message: 'Reached the maximum number of tool rounds for one turn.' });
    return { ok: true, text: finalText, truncated: true };
  }
}

function textOf(message) {
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function imageOf(raw) {
  return raw && typeof raw === 'object' && raw.image ? raw.image : null;
}

/**
 * Normalize a handler return into an Anthropic tool_result `content` value.
 * Supports plain strings and `{ text, image }` (image = PNG data URL) so Claude
 * receives screenshots as real image blocks.
 */
function formatToolResult(raw) {
  if (raw && typeof raw === 'object' && raw.image) {
    const m = /^data:(image\/\w+);base64,(.*)$/s.exec(raw.image);
    const blocks = [];
    if (raw.text) blocks.push({ type: 'text', text: String(raw.text) });
    if (m) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: m[1], data: m[2] },
      });
    }
    return { content: blocks, display: raw.text || '[image]' };
  }
  const text = String(raw ?? '');
  return { content: text, display: text };
}
