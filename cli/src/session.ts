import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ChatMessage } from "./types.js";

export interface SessionData {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  model: string;
  messages: ChatMessage[];
  tokenStats?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export class SessionManager {
  private sessionsDir: string;

  constructor() {
    this.sessionsDir = path.join(os.homedir(), ".nexus", "sessions");
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  public generateSessionId(): string {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const timestamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const rand = Math.random().toString(36).substring(2, 6);
    return `session_${timestamp}_${rand}`;
  }

  public saveSession(session: SessionData): void {
    const filePath = path.join(this.sessionsDir, `${session.id}.json`);
    session.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
  }

  public loadSession(sessionId: string): SessionData | null {
    // Check direct ID or file name
    let cleanId = sessionId.replace(/\.json$/, "");
    let filePath = path.join(this.sessionsDir, `${cleanId}.json`);

    if (!fs.existsSync(filePath)) {
      // Find matching session if partial ID was supplied
      const all = this.listSessions();
      const match = all.find((s) => s.id.startsWith(cleanId) || s.id.includes(cleanId));
      if (match) {
        filePath = path.join(this.sessionsDir, `${match.id}.json`);
      } else {
        return null;
      }
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content) as SessionData;
    } catch {
      return null;
    }
  }

  public getLatestSession(): SessionData | null {
    const list = this.listSessions();
    if (list.length === 0) return null;
    return this.loadSession(list[0].id);
  }

  public listSessions(): Array<{ id: string; title: string; updatedAt: string; workspace: string; messageCount: number }> {
    if (!fs.existsSync(this.sessionsDir)) return [];

    const files = fs.readdirSync(this.sessionsDir).filter((f) => f.endsWith(".json"));
    const results: Array<{ id: string; title: string; updatedAt: string; workspace: string; messageCount: number; mtime: number }> = [];

    for (const file of files) {
      try {
        const fullPath = path.join(this.sessionsDir, file);
        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, "utf-8");
        const data = JSON.parse(content) as SessionData;
        results.push({
          id: data.id || file.replace(/\.json$/, ""),
          title: data.title || "Untitled Session",
          updatedAt: data.updatedAt || stat.mtime.toISOString(),
          workspace: data.workspace || "~",
          messageCount: data.messages ? data.messages.length : 0,
          mtime: stat.mtimeMs,
        });
      } catch {
        // ignore corrupted files
      }
    }

    results.sort((a, b) => b.mtime - a.mtime);
    return results.map(({ mtime, ...rest }) => rest);
  }
}
