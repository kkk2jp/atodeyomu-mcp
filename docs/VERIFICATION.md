# 動作確認手順

> 実装が完了した atodeyomu-mcp を、実際に Claude Code (Cowork) から呼び出して動作確認するための手順です。初回セットアップから、`get_quoted_posts` / `commit_cursor` が正しく動くことの確認、エラー系の確認までをカバーします。

## 0. 前提

- Node.js 20+ がインストール済み
- X Developer アカウント（無料プランで可）

## 1. X Developer Portal でアプリを作成

1. [developer.x.com](https://developer.x.com/) でプロジェクトとアプリを作成する。
2. アプリの **User authentication settings**:
   - **App permissions**: `Read`
   - **Type of App**: `Web App, Automated App or Bot`（Confidential client）
   - **Callback URI / Redirect URL**: `http://127.0.0.1:8787/callback`
3. **Keys and tokens** から **OAuth 2.0 Client ID** と **Client Secret** を控える。

確認ポイント: Callback URI が `auth/setup.ts` の `REDIRECT_URI`（`http://127.0.0.1:8787/callback`）と**完全一致**していること。1文字でも違うとコールバックが届かず認可が失敗する。

## 2. セットアップ

```bash
cd <absolute-path-to-atodeyomu-mcp>
npm install
```

`CLIENT_ID` / `CLIENT_SECRET` は環境変数として渡す（サーバー起動時は §5 の `~/.mcp.json` の `env`、認可時は次の §3 のインライン指定）。

## 3. 認可（初回のみ）

`CLIENT_ID` / `CLIENT_SECRET` を環境変数で渡して実行する。

```bash
CLIENT_ID=<your-client-id> CLIENT_SECRET=<your-client-secret> npm run auth
```

**確認すること:**
- ターミナルに認可 URL が表示される
- 表示された URL をブラウザで開き、X 上で承認する
- 承認後、`http://127.0.0.1:8787/callback` にリダイレクトされ、ブラウザに「認可が完了しました。」と表示される
- ターミナルに「トークンを `~/.atodeyomu-mcp/tokens.json` に保存しました。」と出力され、プロセスが正常終了する（exit code 0）
- `ls -la ~/.atodeyomu-mcp/tokens.json` でファイルが存在し、パーミッションが `600`（`-rw-------`）であること
- `cat ~/.atodeyomu-mcp/tokens.json` の内容に `access_token` / `refresh_token` / `expires_at` / `scope` が入っていること（`scope` は `tweet.read users.read offline.access` の3つだけ）

失敗パターンと対処:
| 症状 | 原因・対処 |
| --- | --- |
| ブラウザがリダイレクトされない/コールバックが届かない | Developer Portal の Callback URI 不一致。再確認する |
| 「state が一致しません」エラー | 認可URLを2回以上開いた、または別プロセスの認可が並行している。`npm run auth` をやり直す |
| 「refresh_token が取得できませんでした」 | スコープに `offline.access` が含まれているか確認 |

## 4. ビルド

```bash
npm run build
```

型エラーが0件で `dist/index.js` が生成されることを確認する。

```bash
ls dist/index.js
```

## 5. `~/.mcp.json` への登録

`args` に渡す絶対パスは、ビルド後にリポジトリのルートで次のコマンドを実行して確認する。

```bash
realpath dist/index.js
```

出力された絶対パスをそのまま `args` に使う。

```jsonc
{
  "mcpServers": {
    "atodeyomu": {
      "command": "node",
      "args": ["<realpath dist/index.js の出力結果>"],
      "env": {
        "CLIENT_ID": "<your-client-id>",
        "CLIENT_SECRET": "<your-client-secret>"
      }
    }
  }
}
```

`env` の `CLIENT_ID` / `CLIENT_SECRET` は、サーバーがアクセストークンを自動リフレッシュする際に必要。これを省くと、認可直後（アクセストークン有効期間中）は動くが、トークン期限切れ後のリフレッシュで失敗する。

登録後、Claude Code (Cowork) を再起動し、MCP サーバーが接続済みであることを確認する（接続中の MCP サーバー一覧に `atodeyomu` が表示される）。

## 6. 事前準備: 検証用の引用ポストを作る

X 上で、適当な投稿に「あとで読む」などのコメントを付けて **引用ポスト** する。最低1件作っておくと、`get_quoted_posts` の絞り込み・`includes` 解決ロジックを実際のデータで確認できる。可能なら画像付きの投稿を引用して、`media` の解決も確認する。

## 7. `get_quoted_posts` の動作確認

Claude Code に「`get_quoted_posts` を呼んで直近の引用ポストを取得して」のように指示する。

**確認すること:**
- レスポンスが `{ "posts": [...], "newest_seen_id": "..." }` の形であること
- 手順6で作った引用ポストが `posts` に含まれていること
- 各 `posts[].quoted_post` に `text` / `created_at` / `author_username` / `url` が入っていること（追加の lookup なしで解決されている）
- 画像付き引用元なら `media` に `{ url, type }` が入っていること。画像が無い引用元は `media: []` であること
- リプライ・通常のリツイート・通常投稿が `posts` に含まれていない（`referenced_tweets.type === "quoted"` 以外は除外されている）こと
- この時点では `~/.atodeyomu-mcp/cursor.json` が**更新されていない**こと（ファイルが存在しないか、前回の値のままであること）

## 8. `commit_cursor` の動作確認

手順7で返ってきた `newest_seen_id` を使い、「`commit_cursor` を `newest_seen_id` の値で呼んで」と指示する。

**確認すること:**
- レスポンスが `{ "last_post_id": "...", "updated_at": "..." }` であること
- `cat ~/.atodeyomu-mcp/cursor.json` の `last_post_id` が指定した値に更新されていること

## 9. 差分取得の確認

再度 `get_quoted_posts` を呼ぶ。

**確認すること:**
- 手順8でコミットした id 以降の引用ポストだけが返る（新規に引用ポストしていなければ `posts: []`, `newest_seen_id: null`）こと
- 手順7で取得済みだった引用ポストが再度返ってこないこと（差分取得が機能している）

`since_id` を明示的に古い値で指定して呼べば、その id 以降を再取得できることも確認できる（取りこぼし時の手動巻き戻し動作）。

## 10. エラー系の確認（任意）

| 確認内容 | 手順 | 期待結果 |
| --- | --- | --- |
| トークンファイル不在 | `~/.atodeyomu-mcp/tokens.json` を一時的にリネームして `get_quoted_posts` を呼ぶ | 「`auth/setup.ts` を再実行してください」という旨のエラーメッセージが返る（トークンや内部URLは含まれない） |
| トークンリフレッシュ | `tokens.json` の `expires_at` を過去の値に書き換えて呼ぶ | 自動的に `refreshOAuth2Token` が走り、`tokens.json` の `access_token`/`refresh_token`/`expires_at` が新しい値に上書きされる |
| レート制限 | 短時間に大量に呼び出す（再現が難しいため任意） | 「レート制限中です。N秒後に再試行してください。」という旨のメッセージが返る |

手順を終えたら、リネームしたファイルを元に戻すこと。

## まとめチェックリスト

- [ ] `npm run auth` でトークン取得・`chmod 600` を確認
- [ ] `npm run build` が型エラー0
- [ ] `~/.mcp.json` 登録後、Claude Code から `atodeyomu` が見える
- [ ] `get_quoted_posts` で引用ポスト・引用元・メディアが正しく返る
- [ ] `get_quoted_posts` 単体ではカーソルが進まない
- [ ] `commit_cursor` でカーソルが進む
- [ ] 2回目の `get_quoted_posts` で差分のみ返る
- [ ] トークン不在時に安全なエラーメッセージが返る
