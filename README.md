# atodeyomu-mcp

X (Twitter) で「あとで読む」目的の **引用リツイート（引用ポスト）** を検出する、読み取り専用の MCP サーバーです。引用ポストとその引用元（本文・メディア・著者）をまとめて取得し、Claude Code → Notion の知識管理パイプラインから利用することを想定しています。

提供するツールは `get_quoted_posts`（前回以降の引用ポストを取得）と `commit_cursor`（取得位置を確定）の 2 つです。X への投稿・いいね・RT などの書き込みは一切行いません。前回どこまで取得したかはローカル（`~/.atodeyomu-mcp/cursor.json`）に記録し、`since_id` で差分だけを取得するため、Notion 照合のコストを抑えられます。

> 動作確認の詳細手順は [docs/VERIFICATION.md](./docs/VERIFICATION.md)、Cowork スケジュールタスクで Notion に記録するまでの手順は [docs/COWORK_PIPELINE.md](./docs/COWORK_PIPELINE.md) を参照してください。設計の詳細は [docs/DESIGN.md](./docs/DESIGN.md)、フロー図つきの仕様は [docs/SPEC.md](./docs/SPEC.md) にあります。

## 必要なもの

- Node.js 20 以上（`npx` が使えること）
- X Developer アカウント（無料プランで可）
- Claude Code

`npx` で実行するため、リポジトリの clone やビルドは不要です。

## セットアップ

### 1. X Developer Portal でアプリを作成

1. [developer.x.com](https://developer.x.com/) でプロジェクトとアプリを作成します。
2. アプリの **User authentication settings** を開き、次のように設定します。
   - **App permissions**: `Read`
   - **Type of App**: `Web App, Automated App or Bot`（Confidential client）
   - **Callback URI / Redirect URL**: `http://127.0.0.1:8787/callback`
   - **Website URL**: 任意の URL（例: GitHub リポジトリ URL）
3. **Keys and tokens** から **OAuth 2.0 Client ID** と **Client Secret** を控えます。

> スコープは `tweet.read` `users.read` `offline.access` の 3 つだけを使います。

### 2. 認可（初回のみ）

トークンを取得する認可を一度だけ実行します。控えた Client ID / Secret をフラグで渡します。

```bash
npx -y atodeyomu-mcp auth --client-id 控えたClientID --client-secret 控えたClientSecret
```

1. ターミナルに表示された認可 URL をブラウザで開きます。
2. X で承認すると `http://127.0.0.1:8787/callback` にリダイレクトされ、access / refresh token を取得します。
3. トークンは `~/.atodeyomu-mcp/tokens.json` に `chmod 600` で保存されます。

以降、トークンは MCP サーバーが自動でリフレッシュします。再認可が必要になるのは refresh token が失効したときだけです（その場合は同じコマンドを再実行）。

### 3. Claude Code への登録

`~/.mcp.json` に次のように登録します。`CLIENT_ID` / `CLIENT_SECRET` は `env` で渡します（サーバーがトークンを自動リフレッシュする際に必要です）。

```jsonc
{
  "mcpServers": {
    "atodeyomu": {
      "command": "npx",
      "args": ["-y", "atodeyomu-mcp"],
      "env": {
        "CLIENT_ID": "控えたClientID",
        "CLIENT_SECRET": "控えたClientSecret"
      }
    }
  }
}
```

登録後、Claude Code を再起動すると `atodeyomu` が接続されます。

> `~/.mcp.json` には秘密情報（Client ID / Secret）が平文で入ります。このファイルを共有・コミットしないでください。

## 使い方

登録後、Claude Code から 2 つのツールを呼び出せます。基本の流れは「`get_quoted_posts` で差分を取得 → 要約して Notion に保存 → 成功したら `commit_cursor` で取得位置を確定」です。

### `get_quoted_posts`

前回確定した位置以降の引用ポストを返します。**この時点では取得位置を進めません。**

**入力**

| パラメータ | 型 | 必須 | デフォルト | 説明 |
| --- | --- | --- | --- | --- |
| `max_results` | number | 任意 | 20 | 1〜100 |
| `since_id` | string | 任意 | カーソル値 | 取りこぼし時に取得開始位置を手動で巻き戻すための上書き |

**出力（例）**

```jsonc
{
  "posts": [
    {
      "id": "1899...",
      "text": "これあとで読む",
      "created_at": "2026-06-20T09:12:00.000Z",
      "url": "https://x.com/your_name/status/1899...",
      "quoted_post": {
        "id": "1898...",
        "text": "引用元の本文 ...",
        "created_at": "2026-06-19T22:00:00.000Z",
        "author_username": "someone",
        "url": "https://x.com/someone/status/1898...",
        "media": [{ "url": "https://pbs.twimg.com/media/xxx.jpg", "type": "photo" }]
      }
    }
  ],
  "newest_seen_id": "1899..."
}
```

前回以降の直近 `max_results` 件のうち、引用ポストだけが `posts` に返ります。「あとで読む」というキーワードでの絞り込みや要約は、呼び出し側（Claude Code のスキル）で行う設計です。

### `commit_cursor`

Notion への保存が成功したあとに呼び、取得位置を進めます。

| パラメータ | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| `post_id` | string | 必須 | ここまで安全に保存できた最後の post id |

全件成功なら `get_quoted_posts` が返した `newest_seen_id` を、一部だけ保存できた場合はその最後の id を渡します。次回の `get_quoted_posts` はその id 以降から再開します。途中で失敗して `commit_cursor` を呼ばなければ取得位置は据え置かれ、次回また同じ差分を取り直せるので取りこぼしが起きません。

## 動作確認

1. X 上で、適当な投稿に「あとで読む」とコメントを付けて **引用ポスト** します。
2. `~/.mcp.json` に登録した状態で Claude Code を起動します。
4. Claude Code に `get_quoted_posts` を呼ぶよう指示します（例:「直近の引用ポストを取得して」）。
5. 手順 1 の引用ポストが、引用元の本文・メディアまで含めて返ってくれば成功です。
6. 続けて、返ってきた `newest_seen_id` で `commit_cursor` を呼び、`~/.atodeyomu-mcp/cursor.json` が更新されることを確認します。次回 `get_quoted_posts` を呼ぶと、その位置以降の差分だけが返ります。

## トラブルシューティング

| 症状 | 対処 |
| --- | --- |
| `認可を再実行してください` と出る | refresh token が失効しています。`npx -y atodeyomu-mcp auth --client-id <ID> --client-secret <SECRET>` をやり直してください。 |
| トークン期限切れ後にリフレッシュで失敗する | `~/.mcp.json` の `env` に `CLIENT_ID` / `CLIENT_SECRET` が設定されているか確認してください。 |
| レート制限のエラー | メッセージ中の `Retry-After`（秒）だけ待ってから再試行してください。 |
| コールバックが届かない | Developer Portal の Callback URI が `http://127.0.0.1:8787/callback` と完全一致しているか確認してください。 |

## セキュリティ

- Client ID / Secret は `~/.mcp.json` の `env` に平文で入ります。`~/.mcp.json` とトークン（`~/.atodeyomu-mcp/tokens.json`）は秘密情報です。コミット・共有しないでください。
- 資格情報（Client ID / Secret）は、サーバー起動時は `~/.mcp.json` の `env`、認可時は `--client-id` / `--client-secret` フラグで渡します。
- トークンファイルは `chmod 600` で保存されます。
- カーソル（`~/.atodeyomu-mcp/cursor.json`）は秘密情報ではありませんが、トークンと同じディレクトリで管理されます。取得位置をリセットしたい場合はこのファイルを削除してください。ただし次回呼び出しは `since_id` なしになるため、タイムラインの直近 `max_results` 件（既定20・最大100）の中から引用ポストを探すだけで、それより古い投稿は一度の呼び出しでは取得されません。古い投稿まで遡りたい場合は `max_results` を増やすか、`since_id` を指定して複数回呼び出してください。
- 本サーバーは X に対して読み取り専用で、書き込み権限は要求しません（ローカルのカーソルファイルのみ書き込みます）。

## 免責

This project is **unofficial, community-maintained, and not affiliated with X Corp.** Use at your own risk. "X" and "Twitter" are trademarks of their respective owners.
