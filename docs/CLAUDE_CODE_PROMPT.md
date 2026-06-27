# Claude Code 実装プロンプト（atodeyomu-mcp）

> 以下をそのまま Claude Code に貼って使う。実装の正は `docs/DESIGN.md`。

---

このリポジトリ（atodeyomu-mcp）の MCP サーバーを実装してください。**設計の正は `docs/DESIGN.md`** です。まず `docs/DESIGN.md` と `docs/SPEC.md` を読み、その仕様どおりに実装してください。以下は要点とガードレールです。設計書と矛盾する指示があれば設計書を優先し、判断に迷う点は**実装前に質問**してください。

## ゴール

X (Twitter) の「あとで読む」目的の引用リツイートを取得する、**読み取り専用**の MCP サーバー。Claude Code → Notion の知識管理パイプラインから呼ばれる。`npm run build` が通り、`~/.mcp.json` に登録して `get_quoted_posts` / `commit_cursor` が動く状態がゴール。

## 技術スタック（厳守）

- TypeScript / Node.js 20+
- `@modelcontextprotocol/sdk`（stdio transport）
- `twitter-api-v2`（X API v2、OAuth 2.0 PKCE）
- パッケージ管理 npm

## 作るもの（`docs/DESIGN.md` §4 の構成に従う）

```
auth/setup.ts                 # 一度だけ実行する OAuth 認可スクリプト
src/index.ts                  # MCP 本体（stdio, 2ツール登録）
src/twitter-client.ts         # トークン読込・自動リフレッシュ・X API 呼び出し
src/cursor.ts                 # cursor.json の読み書き
src/tools/get-quoted-posts.ts # get_quoted_posts 実装
src/tools/commit-cursor.ts    # commit_cursor 実装
.env.example / .gitignore / package.json / tsconfig.json
```

`package.json` の scripts には最低限 `build`（tsc）、`auth`（`auth/setup.ts` 実行、tsx 等）、`start`（`dist/index.js` 起動）を用意。

## 外してはいけない要点

1. **ツールは2つだけ**: `get_quoted_posts` と `commit_cursor`。X への投稿・いいね・RT・フォローなど書き込み系は一切実装しない。
2. **認証**: OAuth 2.0 Authorization Code + PKCE。スコープは `tweet.read users.read offline.access` の3つのみ（`bookmark.read` 不要）。`auth/setup.ts` は認可URL表示 → ローカルHTTPサーバ（ポート8787、`/callback`）で `code` 受領 → `loginWithOAuth2()` → `~/.atodeyomu-mcp/tokens.json` に `chmod 600` で保存。リダイレクトURIは `http://127.0.0.1:8787/callback`。`CLIENT_ID`/`CLIENT_SECRET` は `.env` から。
3. **トークン**: 起動・ツール呼び出し時に読み込み、期限切れ間近なら `refreshOAuth2Token()` で更新。refresh token は**ローテーション（使い切り）**なので、更新のたびに新しい access/refresh/有効期限で `tokens.json` を**上書き**。
4. **`get_quoted_posts`**:
   - 入力 `max_results`（既定20・最大100）、任意 `since_id`（上書き用）。
   - カーソル解決順: 入力 `since_id` > `cursor.json` の `last_post_id` > なし（初回・全件）。
   - `GET /2/users/:id/tweets` を `tweet.fields=created_at,text,referenced_tweets` / `expansions=referenced_tweets.id,referenced_tweets.id.attachments.media_keys,referenced_tweets.id.author_id` / `media.fields=url,type` / `user.fields=username` / `since_id`（値があれば）で呼ぶ。
   - `referenced_tweets` に `type==="quoted"` を含むものだけ抽出。引用元・著者・メディアは `includes` から解決（**追加のlookup呼び出しはしない**）。`url` は `username`+`id` で組み立て。
   - 返り値は `{ posts: [...], newest_seen_id }`。`newest_seen_id` はタイムライン全体（引用以外含む）の最大id、新着なしなら `null`。**カーソルは進めない。**
5. **`commit_cursor`**: 入力 `post_id`（必須）。`cursor.json` の `last_post_id` を上書きするだけ。X API は呼ばない。
6. **カーソルファイル**: `~/.atodeyomu-mcp/cursor.json`（`{ last_post_id, updated_at }`）。トークンとは別ファイル。
7. **ページングは実装しない**（`pagination_token` 不要）。
8. **エラーハンドリング**: 429 はレート制限である旨と `Retry-After` を含める。401/refresh失効・トークンファイル不在は「`auth/setup.ts` を再実行してください」。その他の X API エラーは**生レスポンスを転送せず**、必要最小限だけ抽出（内部URL・トークンを漏らさない）。

## セキュリティ / ガードレール

- `.gitignore` に `.env` と `~/.atodeyomu-mcp/` 系（トークン・カーソル）を含める。シークレット・トークンは絶対にコミットしない。
- `.env.example` を用意（実値は入れない）。
- エラーメッセージにトークン・内部URLを含めない。

## 完了時にやること

1. `npm install` → `npm run build` が型エラー0で通ることを確認。
2. 主要ロジック（引用抽出・includes解決・カーソル解決・エラー整形）に最小限のテストか、手動確認手順を残す。
3. **実装の過程で仕様を調整した場合**（パラメータ名・返り値・パス・挙動など）、`doc-sync` サブエージェントを呼んで `docs/DESIGN.md`・`docs/SPEC.md`・`README.md` を実装に合わせて更新する。
4. 変更点と、手元での動作確認手順（`npm run auth` → `~/.mcp.json` 登録 → `get_quoted_posts` 実行）を簡潔に報告。

不明点・設計書だけでは決められない点があれば、実装を始める前に質問してください。
