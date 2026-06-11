/**
 * Chat With Model (CWM) — session persistence.
 *
 * CWM is the conversational mode: plain chat with a model, attachments and
 * media generation. Its history is stored COMPLETELY apart from agent/IDE
 * sessions — one JSON file per session under userData/cwm/sessions/.
 *
 * Isolation note: this service only reads/writes its own directory inside
 * userData. It has no access to the workspace, the agent loop or the
 * terminal — and the CWM renderer code never invokes those channels.
 */
import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface CwmSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Last model used in this session, for the list UI. */
  model?: string;
}

export interface CwmSessionDoc extends CwmSessionMeta {
  /** Renderer-owned message objects. Persisted opaquely, validated for shape. */
  messages: unknown[];
}

const MAX_SESSIONS = 200;
const MAX_DOC_BYTES = 8 * 1024 * 1024; // 8 MB per session file

function sessionsDir(): string {
  return path.join(app.getPath('userData'), 'cwm', 'sessions');
}

/** Session ids are renderer-generated; constrain them to a safe alphabet so
 *  they can never escape the sessions directory. */
function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id);
}

function sessionPath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(sessionsDir(), { recursive: true });
}

export const cwmSessions = {
  async list(): Promise<CwmSessionMeta[]> {
    await ensureDir();
    const out: CwmSessionMeta[] = [];
    let files: string[] = [];
    try {
      files = await fs.readdir(sessionsDir());
    } catch {
      return [];
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(sessionsDir(), f), 'utf-8');
        const doc = JSON.parse(raw);
        if (!isSafeId(doc?.id)) continue;
        out.push({
          id: doc.id,
          title: String(doc.title || 'Без названия').slice(0, 200),
          createdAt: Number(doc.createdAt) || 0,
          updatedAt: Number(doc.updatedAt) || 0,
          messageCount: Array.isArray(doc.messages) ? doc.messages.length : 0,
          model: typeof doc.model === 'string' ? doc.model : undefined,
        });
      } catch {
        /* skip corrupt file */
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out.slice(0, MAX_SESSIONS);
  },

  async get(id: string): Promise<{ ok: boolean; session?: CwmSessionDoc; error?: string }> {
    if (!isSafeId(id)) return { ok: false, error: 'bad session id' };
    try {
      const raw = await fs.readFile(sessionPath(id), 'utf-8');
      const doc = JSON.parse(raw);
      if (!isSafeId(doc?.id) || doc.id !== id) return { ok: false, error: 'corrupt session' };
      if (!Array.isArray(doc.messages)) doc.messages = [];
      return { ok: true, session: doc };
    } catch (err: any) {
      return { ok: false, error: err?.code === 'ENOENT' ? 'not found' : String(err?.message || err) };
    }
  },

  async save(doc: CwmSessionDoc): Promise<{ ok: boolean; error?: string }> {
    if (!isSafeId(doc?.id)) return { ok: false, error: 'bad session id' };
    if (!Array.isArray(doc.messages)) return { ok: false, error: 'messages must be an array' };
    const normalized: CwmSessionDoc = {
      id: doc.id,
      title: String(doc.title || 'Без названия').slice(0, 200),
      createdAt: Number(doc.createdAt) || Date.now(),
      updatedAt: Date.now(),
      messageCount: doc.messages.length,
      model: typeof doc.model === 'string' ? doc.model.slice(0, 200) : undefined,
      messages: doc.messages,
    };
    const json = JSON.stringify(normalized);
    if (Buffer.byteLength(json, 'utf-8') > MAX_DOC_BYTES) {
      return { ok: false, error: 'session too large (8 MB limit) — начните новую сессию' };
    }
    try {
      await ensureDir();
      // Write-then-rename so a crash mid-write never corrupts the session.
      const tmp = sessionPath(normalized.id) + '.tmp';
      await fs.writeFile(tmp, json, 'utf-8');
      await fs.rename(tmp, sessionPath(normalized.id));
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  },

  async delete(id: string): Promise<{ ok: boolean; error?: string }> {
    if (!isSafeId(id)) return { ok: false, error: 'bad session id' };
    try {
      await fs.unlink(sessionPath(id));
      return { ok: true };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { ok: true };
      return { ok: false, error: String(err?.message || err) };
    }
  },
};
