# 動作確認手順

> atodeyomu-mcp を、実際に Claude（Cowork）から呼び出して動作確認するための手順です。初回セットアップから、`get_quoted_posts` / `commit_cursor` が正しく動くことの確認、エラー系の確認までをカバーします。`npx` 経由で実行するため、clone やビルドは不要です。

## 0. 前提

- Node.js 20+ がインストール済み（`npx` が使えること）
- X Developer アカウント（無料プランで可）

## 1. X Developer Portal でアプリを作成

1. [developer.x.com](https://developer.x.com/) でプロジェクトとアプリを作成する。
2. アプリの **User authentication settings**:
   - **App permissions**: `Read`
   - **Type of App**: `Web App, Automated App or Bot`（Confidential client）
   - **Callback URI / Redirect URL**: `http://127.0.0.1:8787/callback`
3. **Keys and tokens** から **OAuth 2.0 Client ID** と **Client Secret** を控える。

確認ポイント: Callback URI が本サーバーの待ち受け先（`http://127.0.0.1:8787/callback`）と**完全一致**していること。1文字でも違うとコールバックが届かず認可が失敗する。

## 2. セットアップ（ビルド不要）

`npx` 経由で実行するため、clone やインストールは不要。X API 資格情報 `CLIENT_ID` / `CLIENT_SECRET` は、サーバー起動時は §4 の MCP 設定ファイル（`claude_desktop_config.json`）の `env`、認可時は §3 の `--client-id` / `--client-secret` フラグで渡す。初回の `npx -y atodeyomu-mcp ...` 実行時にパッケージが取得され、以降はキャッシュされる。

## 3. 認可（初回のみ）

Client ID / Secret をフラグで渡して実行する。

```bash
npx -y atodeyomu-mcp auth --client-id <your-client-id> --client-secret <your-client-secret>
```

**確認すること:**
- ターミナルに認可 URL が表示される
- 表示された URL をブラウザで開き、X 上で承認する
- 承認後、`http://127.0.0.1:8787/callback` にリダイレクトされ、ブラウザに「認可が完了しました。」と表示される
- ターミナルに「トークンを `~/.atodeyomu-mcp/tokens.json` に保存しました。」と出力され、プロセスが正常終了する
- `ls -la ~/.atodeyomu-mcp/tokens.json` でファイルが存在し、パーミッションが `600`（`-rw-------`）であること
- `cat ~/.atodeyomu-mcp/tokens.json` の内容に `access_token` / `refresh_token` / `expires_at` / `scope` が入っていること（`scope` は `tweet.read users.read offline.access` の3つだけ）

失敗パターンと対処:
| 症状 | 原因・対処 |
| --- | --- |
| ブラウザがリダイレクトされない/コールバックが届かない | Developer Portal の Callback URI 不一致。再確認する |
| 「state が一致しません」エラー | 認可URLを2回以上開いた、または別プロセスの認可が並行している。コマンドをやり直す |
| 「refresh_token が取得できませんでした」 | スコープに `offline.access` が含まれているか確認 |

## 4. MCP 設定ファイルへの登録

Claude（Cowork / デスクトップアプリ）の MCP 設定ファイルの `mcpServers` に追記する（他のキーは消さない）。

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```jsonc
{
  "mcpServers": {
    "atodeyomu": {
      "command": "npx",
      "args": ["-y", "atodeyomu-mcp@latest"],
      "env": {
        "CLIENT_ID": "<your-client-id>",
        "CLIENT_SECRET": "<your-client-secret>"
      }
    }
  }
}
```

`env` の `CLIENT_ID` / `CLIENT_SECRET` は、サーバーがアクセストークンを自動リフレッシュする際に必要。これを省くと、認可直後（アクセストークン有効期間中）は動くが、トークン期限切れ後のリフレッシュで失敗する。

保存後、Claude（Cowork）アプリを再起動し、MCP サーバーが接続済みであることを確認する（接続中の MCP サーバー一覧に `atodeyomu` が表示される）。

## 5. 事前準備: 検証用の引用ポストを作る

X 上で、適当な投稿に「あとで読む」などのコメントを付けて **引用ポスト** する。最低1件作っておくと、`get_quoted_posts` の絞り込み・`includes` 解決ロジックを実際のデータで確認できる。可能なら画像付きの投稿を引用して、`media` の解決も確認する。

## 6. `get_quoted_posts` の動作確認

Claude（Cowork）に「`get_quoted_posts` を呼んで直近の引用ポストを取得して」のように指示する。

**確認すること:**
- レスポンスが `{ "posts": [...], "newest_seen_id": "..." }` の形であること
- 手順5で作った引用ポストが `posts` に含まれていること
- 各 `posts[].quoted_post` に `text` / `created_at` / `author_username` / `url` が入っていること（追加の lookup なしで解決されている）
- 画像付き引用元なら `media` に `{ url, type }` が入っていること。画像が無い引用元は `media: []` であること
- リプライ・通常のリツイート・通常投稿が `posts` に含まれていない（`referenced_tweets.type === "quoted"` 以外は除外されている）こと
- この時点では `~/.atodeyomu-mcp/cursor.json` が**更新されていない**こと（ファイルが存在しないか、前回の値のままであること）

## 7. `commit_cursor` の動作確認

手順6で返ってきた `newest_seen_id` を使い、「`commit_cursor` を `newest_seen_id` の値で呼んで」と指示する。

**確認すること:**
- レスポンスが `{ "last_post_id": "...", "updated_at": "..." }` であること
- `cat ~/.atodeyomu-mcp/cursor.json` の `last_post_id` が指定した値に更新されていること

## 8. 差分取得の確認

再度 `get_quoted_posts` を呼ぶ。

**確認すること:**
- 手順7でコミットした id 以降の引用ポストだけが返る（新規に引用ポストしていなければ `posts: []`, `newest_seen_id: null`）こと
- 手順6で取得済みだった引用ポストが再度返ってこないこと（差分取得が機能している）

`since_id` を明示的に古い値で指定して呼べば、その id 以降を再取得できることも確認できる（取りこぼし時の手動巻き戻し動作）。

## 9. エラー系の確認（任意）

| 確認内容 | 手順 | 期待結果 |
| --- | --- | --- |
| トークンファイル不在 | `~/.atodeyomu-mcp/tokens.json` を一時的にリネームして `get_quoted_posts` を呼ぶ | 「認可を再実行してください」という旨のエラーメッセージが返る（トークンや内部URLは含まれない） |
| トークンリフレッシュ | `tokens.json` の `expires_at` を過去の値に書き換えて呼ぶ | 自動的に `refreshOAuth2Token` が走り、`tokens.json` の `access_token`/`refresh_token`/`expires_at` が新しい値に上書きされる |
| レート制限 | 短時間に大量に呼び出す（再現が難しいため任意） | 「レート制限中です。N秒後に再試行してください。」という旨のメッセージが返る |

手順を終えたら、リネームしたファイルを元に戻すこと。

## まとめチェックリスト

- [ ] `npx -y atodeyomu-mcp auth` でトークン取得・`chmod 600` を確認
- [ ] MCP 設定ファイル登録後、Claude（Cowork）から `atodeyomu` が見える
- [ ] `get_quoted_posts` で引用ポスト・引用元・メディアが正しく返る
- [ ] `get_quoted_posts` 単体ではカーソルが進まない
- [ ] `commit_cursor` でカーソルが進む
- [ ] 2回目の `get_quoted_posts` で差分のみ返る
- [ ] トークン不在時に安全なエラーメッセージが返る
