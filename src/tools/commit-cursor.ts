import { saveCursor } from "../cursor.js";

export interface CommitCursorInput {
  post_id: string;
}

export interface CommitCursorOutput {
  last_post_id: string;
  updated_at: string;
}

export function commitCursor(input: CommitCursorInput): CommitCursorOutput {
  return saveCursor(input.post_id);
}
