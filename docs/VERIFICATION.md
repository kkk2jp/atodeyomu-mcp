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
- レスポンスが `{ "posts": [...], "newest_seen_id": "...", "next_token": ..., "has_more": ... }` の形であること
- 手順5で作った引用ポストが `posts` に含まれていること
- 各 `posts[].quoted_post` に `text` / `created_at` / `author_username` / `url` が入っていること（追加の lookup なしで解決されている）
- 通常の文字数上限を超える「長いポスト」を引用・引用元にしていた場合、`text` が途中で切れておらず全文取れていること（`note_tweet` があれば優先される）
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

## 8-2. ページングの確認（任意、差分が `max_results` を超える場合）

`max_results` を小さめ（例: 1）にして `get_quoted_posts` を呼び、引用ポストが2件以上溜まっている状態を作る。

**確認すること:**
- レスポンスに `next_token` が値を持つこと
- その値を `pagination_token` に渡して呼び直すと、続きの(より古い)引用ポストが返ること
- 全ページの `posts` を合算すると、取りこぼしなく全件揃うこと
- 最終的に `commit_cursor` へ渡すのは、**1回目（`pagination_token` 未指定）の呼び出しで返った `newest_seen_id`** であること（2ページ目以降の `newest_seen_id` はより古いページのものなので使わない）

## 8-3. `limit` モードの確認（推奨。Cowork パイプラインが使う経路）

`get_quoted_posts` を `limit: 2` のように小さい値で呼ぶ（引用ポストが3件以上溜まっている状態を作っておく）。

**確認すること:**
- `posts` が**古い順（id 昇順）**に並んで最大 `limit` 件だけ返ること（呼び出し側でのページ送りは不要。MCP が内部で全ページを取得して絞り込む）
- `next_token` は常に `null`、`has_more` が `true`（`limit` を超える残りがある）であること
- `limit` を溜まっている件数より大きくして呼ぶと、全件が返り `has_more` が `false` になること
- `has_more: true` のときは `posts` の最後（最も新しい）の id を、`false` のときは `newest_seen_id` を `commit_cursor` に渡す運用であること（[docs/COWORK_PIPELINE.md](./COWORK_PIPELINE.md) §5）

## 8-4. `fetch_article` の動作確認

`fetch_article` に URL を渡して、`status` ごとの挙動を確認する。X の認証やカーソルとは無関係なので、任意の URL で単体確認できる。

| 渡す URL | 期待する `status` | 確認すること |
| --- | --- | --- |
| 外部記事の URL（Zenn / Qiita / ブログ等。`t.co` 短縮のままでよい） | `ok` | リダイレクトが最終記事 URL（`final_url`）まで解決され、`text` に記事本文（ナビ・広告を除く）が入る。`title` も取れる |
| X の別ポストに解決される URL（`x.com/…/status/…`） | `x_post` | fetch されず、`text` は空文字。`final_url` はそのポストの URL |
| X ネイティブ記事の URL（`x.com/i/article/…`） | `x_article` | fetch されず、`text` は空文字。`detail` に認証必須の旨が入る |
| 画像など HTML でない URL | `not_article` | `detail` に content-type が入る |
| 存在しない URL・リンク切れ | `fetch_failed` | `detail` に HTTP ステータス等が入る（トークンや内部情報は含まれない） |

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
- [ ] 長いポスト（note_tweet）の本文が切れずに全文取れる
- [ ] `next_token` を使ったページ送りで、`max_results` を超える差分も取りきれる
- [ ] `limit` モードで古い順 N 件だけが返り、`has_more` が正しい
- [ ] `fetch_article` が外部記事で `ok`（本文抽出）、X 別ポストで `x_post`、X ネイティブ記事で `x_article` を返す
- [ ] トークン不在時に安全なエラーメッセージが返る
