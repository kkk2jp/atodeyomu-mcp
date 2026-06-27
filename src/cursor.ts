import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".atodeyomu-mcp");
const CURSOR_PATH = join(CONFIG_DIR, "cursor.json");

interface CursorFile {
  last_post_id: string;
  updated_at: string;
}

export function loadCursor(): string | null {
  if (!existsSync(CURSOR_PATH)) {
    return null;
  }
  const raw = readFileSync(CURSOR_PATH, "utf-8");
  const parsed = JSON.parse(raw) as CursorFile;
  return parsed.last_post_id;
}

export function saveCursor(postId: string): CursorFile {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const cursor: CursorFile = {
    last_post_id: postId,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(CURSOR_PATH, JSON.stringify(cursor, null, 2), { mode: 0o600 });
  return cursor;
}
