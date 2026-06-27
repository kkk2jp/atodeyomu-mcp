# atodeyomu-mcp 設計書

> このドキュメントは Claude Code に実装を依頼する際の入力（設計仕様）です。実装時はこの設計を正とし、曖昧な点が出た場合のみ確認してください。

## 1. 概要

X (Twitter) で「あとで読む」目的の引用リツイートを検出するための、**読み取り専用**の MCP サーバー。TypeScript で実装する。個人の知識管理パイプライン（Claude Code → Notion）から、本サーバーが公開するツール `get_quoted_posts` を呼び出して使う。

本サーバーの責務は **「引用リツイートかどうか」という構造的判定（`referenced_tweets.type === "quoted"`）と、引用元コンテンツの取得**、および **取得位置（カーソル）のローカル管理** のみ。キーワード判定・要約・Notion への書き込みは呼び出し側（Claude Code のスキル）の責務であり、本サーバーには実装しない。

下流（Notion 照合・要約）のコストを抑えるため、本サーバーは前回取得位置をローカルに記録し、X API の `since_id` で **差分だけ** を返す。カーソルの前進は取得時に自動では行わず、呼び出し側が下流処理（Notion 書き込み）の成功を確認してから `commit_cursor` ツールで明示的に確定する（取りこぼし防止）。

## 2. 技術スタック

| 項目 | 採用 |
| --- | --- |
| 言語 | TypeScript |
| ランタイム | Node.js 20+ |
| MCP SDK | `@modelcontextprotocol/sdk`（stdio transport） |
| X API クライアント | `twitter-api-v2`（X API v2、OAuth 2.0 PKCE 対応） |
| パッケージ管理 | npm |

## 3. スコープ（厳守）

**実装するもの**

- ツール `get_quoted_posts`（差分取得）と `commit_cursor`（カーソル確定）の 2 つ。
- OAuth 2.0 Authorization Code + PKCE による認可フロー（`src/auth.ts`、`atodeyomu-mcp auth` サブコマンド）。
- トークンの読み込み・自動リフレッシュ・ファイル書き戻し。
- 取得位置カーソル（`last_post_id`）のローカル読み書き（`since_id` 差分取得の根拠は §7）。

**実装しないもの（明示的に除外）**

- 投稿・いいね・リツイート・フォローなど **書き込み系の機能は一切実装しない**（X への書き込みの意。カーソルファイルへのローカル書き込みは行う）。
- 「本文に“あとで読む”を含むか」という **キーワード判定は実装しない**（呼び出し側の責務）。
- 要約・Notion 連携ロジックは実装しない。
- ページング（`pagination_token`）は実装しない。差分が `max_results` を超えた分は次回実行で拾う（§7）。

## 4. ディレクトリ構成

```
atodeyomu-mcp/
├── src/
│   ├── index.ts              # CLI エントリ兼 MCP サーバー本体（bin）。引数で auth/サーバーを分岐
│   ├── auth.ts               # OAuth 認可フロー（`atodeyomu-mcp auth` サブコマンドから呼ぶ）
│   ├── twitter-client.ts     # トークン読込・リフレッシュ・API 呼び出し
│   ├── cursor.ts             # カーソル(last_post_id)の読み書き
│   └── tools/
│       ├── get-quoted-posts.ts  # get_quoted_posts ツールの実装本体
│       └── commit-cursor.ts     # commit_cursor ツールの実装本体
├── docs/
│   ├── DESIGN.md             # 本書
│   └── SPEC.md               # 人間向け仕様書（mermaid フロー図）
├── .gitignore
├── package.json              # bin=dist/index.js / files=["dist"] / prepare で自動ビルド
├── tsconfig.json
└── README.md
```

`npx -y atodeyomu-mcp` で実行できるよう npm パッケージとして公開する。`bin` は `dist/index.js`（先頭に shebang）。`dist` はビルド成果物で、公開物（`files`）に含める。

## 5. モジュール責務

### 5.1 `src/auth.ts`（認可フロー）

`atodeyomu-mcp auth` サブコマンドから一度だけ実行し、トークンを取得・保存する（`runAuth()` を `index.ts` が呼ぶ）。

- `index.ts` が `--client-id` / `--client-secret` フラグ（無ければ環境変数 `CLIENT_ID` / `CLIENT_SECRET`）を解決し、`runAuth(clientId, clientSecret)` に渡す（`npx -y atodeyomu-mcp auth --client-id <ID> --client-secret <SECRET>`）。
- `twitter-api-v2` の `generateOAuth2AuthLink()` で認可 URL・`codeVerifier`・`state` を生成し、認可 URL をターミナルに表示する。
- ローカルに一時 HTTP サーバー（**ポート 8787**）を立て、X からのリダイレクト `GET /callback?code=...&state=...` を受け取る。
- `state` の一致を検証してから、`loginWithOAuth2({ code, codeVerifier, redirectUri })` で access token / refresh token / expires_in を取得する。
- 取得したトークンを `~/.atodeyomu-mcp/tokens.json` に保存する（ディレクトリは存在しなければ作成、ファイルは `chmod 600`）。
- 完了後、一時 HTTP サーバーを閉じてプロセスを終了する。
- 要求スコープは **`tweet.read` `users.read` `offline.access` の 3 つのみ**。

リダイレクト URI は `http://127.0.0.1:8787/callback` とする（X Developer Portal の Callback URI に同一値を登録する前提）。

### 5.2 `src/twitter-client.ts`（クライアント層）

トークンライフサイクルと X API 呼び出しを担う。

- `loadTokens()`: `~/.atodeyomu-mcp/tokens.json` を読み込む。存在しなければ「`atodeyomu-mcp auth` を実行してください」という旨のエラーを投げる。
- `ensureFreshToken()`: access token が **期限切れまたは期限切れ間近（残り 60 秒未満を目安）** の場合、`refreshOAuth2Token(refreshToken)` で更新する。
  - X 側の仕様で **refresh token はローテーション（使い切り）** するため、更新で得た新しい access / refresh token と新しい有効期限を `tokens.json` に **上書き保存** する。
- `getOwnUser()`: `users.read` の範囲で自分の `id` と `username` を取得する（`GET /2/users/me`）。`url` 組み立てに使う。`username` はプロセス内でキャッシュしてよい。
- `fetchUserTweets(max_results, since_id?)`: 自分のタイムラインを取得する（パラメータは §6）。`since_id` が与えられた場合のみクエリに付与する。

### 5.3 `src/cursor.ts`（カーソル層）

取得位置カーソルのローカル永続化を担う。トークンとは別ファイルで管理する。

- 保存先: `~/.atodeyomu-mcp/cursor.json`。中身は `{ "last_post_id": "<string>", "updated_at": "<ISO8601>" }`。
- 秘密情報ではないが、`~/.atodeyomu-mcp/` 配下に置く（パーミッションはトークンに合わせて `600` でよい）。
- `loadCursor()`: ファイルを読み、`last_post_id` を返す。存在しなければ `null`（＝初回実行 → `since_id` なしで呼び出し、タイムラインの直近 `max_results` 件を取得）。
- `saveCursor(post_id)`: `last_post_id` と `updated_at` を書き込む（上書き）。`commit_cursor` から呼ぶ。

### 5.4 `src/tools/get-quoted-posts.ts`（ツール実装）

`get_quoted_posts` の入出力定義とロジック本体。カーソルを読み、クライアント層を使い、レスポンスを整形する（§6.1〜6.5）。**カーソルの前進は行わない。**

### 5.5 `src/tools/commit-cursor.ts`（ツール実装）

`commit_cursor` の入出力定義。受け取った `post_id` を `saveCursor()` でカーソルファイルに確定する（§6.6）。

### 5.6 `src/index.ts`（CLI エントリ / サーバー本体）

- 先頭に shebang（`#!/usr/bin/env node`）を持つ実行可能エントリ（`package.json` の `bin`）。
- `process.argv[2]` を見て分岐する: `auth` なら `runAuth()`（§5.1）を実行、それ以外は MCP サーバーを起動する。
- stdio transport で MCP サーバーを起動する。
- 起動時にトークンを読み込む。
- `CLIENT_ID` / `CLIENT_SECRET` は環境変数（`process.env`）から読む。MCP クライアントが `~/.mcp.json` の `env` で渡す前提。
- ツール `get_quoted_posts` と `commit_cursor` を登録する。
- X API を呼ぶツール（`get_quoted_posts`）では呼び出しのたびに `ensureFreshToken()` を通す。`commit_cursor` はローカルファイル書き込みのみで X API を呼ばない。

## 6. ツール仕様

### 6.1 `get_quoted_posts` 入力パラメータ

| 名前 | 型 | 必須 | デフォルト | 制約 |
| --- | --- | --- | --- | --- |
| `max_results` | number | 任意 | 20 | 1〜100 |
| `since_id` | string | 任意 | （カーソル値） | 数字文字列。指定時はカーソルより優先し、その id 以降を取得（取りこぼし時の手動巻き戻し用） |

カーソル解決の優先順位: 入力 `since_id` > `cursor.json` の `last_post_id` > なし（初回・`since_id` 省略）。

`since_id` がない場合、`since_id` パラメータを付けずに呼び出すため、X API はタイムラインの直近 `max_results` 件（既定20・最大100）のみを返す。本サーバーはページング（`pagination_token`）を実装していないため、それより古い投稿は一度の呼び出しでは取得されない（§7）。

### 6.2 X API 呼び出し

エンドポイント: `GET /2/users/:id/tweets`（`:id` は自分の user id）

クエリパラメータ:

```
tweet.fields = created_at,text,referenced_tweets
expansions   = referenced_tweets.id,referenced_tweets.id.attachments.media_keys,referenced_tweets.id.author_id
media.fields = url,type
user.fields  = username
max_results  = <入力値>
since_id     = <解決済みカーソル>   # 値がある場合のみ付与
```

### 6.3 絞り込みロジック

レスポンス `data` 配列のうち、`referenced_tweets` に **`type === "quoted"` を含むものだけ** を残す。リプライ（`replied_to`）・リツイート（`retweeted`）・通常投稿は除外する。

### 6.4 出力

最上位はオブジェクト。`posts` に絞り込んだ引用ポスト配列、`newest_seen_id` に「今回取得したタイムライン全体（引用以外も含む）の最大 id」を入れる。`newest_seen_id` は全件を正常処理できた場合に `commit_cursor` へ渡す値。新着が無ければ `posts` は空配列、`newest_seen_id` は `null`。

```jsonc
{
  "posts": [
    {
      "id": "string",                       // 自分の引用ポストの ID
      "text": "string",                     // 引用コメント本文
      "created_at": "string",               // ISO 8601
      "url": "https://x.com/{自分のusername}/status/{id}",
      "quoted_post": {
        "id": "string",                     // 引用元ポストの ID
        "text": "string",                   // 引用元本文
        "created_at": "string",
        "author_username": "string",        // includes.users から解決
        "url": "https://x.com/{author_username}/status/{id}",
        "media": [                          // includes.media から解決、なければ []
          { "url": "string", "type": "photo|video|animated_gif" }
        ]
      }
    }
  ],
  "newest_seen_id": "string | null"          // タイムライン全体の最大 id（引用以外も含む）
}
```

> `newest_seen_id` を「引用ポストの最大 id」ではなく「タイムライン全体の最大 id」にする理由: 引用以外の post もカーソルで「見た」扱いにし、次回 `since_id` で再取得しないため。`posts` 配列の各 `id` は時系列順（id が大きいほど新しい）であり、呼び出し側は部分成功時に「安全に保存できた最後の id」を選んで `commit_cursor` に渡せる。

### 6.5 引用元・メディア・著者の解決手順

1. 各引用ポストの `referenced_tweets` から `type === "quoted"` の `id`（= `quoted_id`）を取得。
2. `includes.tweets` から `id === quoted_id` のオブジェクトを引き、`text` / `created_at` / `author_id` / `attachments.media_keys` を得る。
3. `author_username`: `includes.users` から `id === author_id` の `username` を解決。
4. `media`: 引用元の `attachments.media_keys` を、`includes.media` の `media_key` で解決し、`{ url, type }` の配列にする。`media_keys` が無い、または解決できない場合は空配列 `[]`。
5. `url` は組み立て式（API から URL は返らない）:
   - 自分の引用ポスト: `https://x.com/{own_username}/status/{post.id}`
   - 引用元: `https://x.com/{author_username}/status/{quoted_id}`

> **設計判断の根拠**: `expansions=referenced_tweets.id` を使うことで、引用元ポストの本文・メディアを **追加の API 呼び出しなしで同じレスポンスから** 取得できる。2 回目の lookup 呼び出しは不要。

### 6.6 `commit_cursor` 仕様

下流処理（Notion 書き込み）が成功した後に呼び、カーソルを前進させる。X API は呼ばない。

入力パラメータ:

| 名前 | 型 | 必須 | 制約 |
| --- | --- | --- | --- |
| `post_id` | string | 必須 | 数字文字列。ここまで安全に保存済みである最後の post id |

処理: `saveCursor(post_id)` で `cursor.json` を上書きする。出力は確定後のカーソル（例: `{ "last_post_id": "105", "updated_at": "..." }`）。

呼び出し側の使い方:

- 全件正常に Notion 保存できた → `get_quoted_posts` の `newest_seen_id` を渡す。
- 一部だけ保存できた（部分成功）→ 保存できた最後の post id を渡す。次回はその id 以降から再開する。
- 何も保存しなかった → 呼ばない（カーソルは進まず、次回また同じ差分が返る）。

## 7. カーソルによる差分取得の設計（`since_id`）

本サーバーはローカルカーソル（`last_post_id`）を持ち、X API の `since_id` で **前回以降の差分だけ** を取得する。これにより、下流の Notion 照合・要約に渡るデータ量が新着分に限定され、Notion 接続回数と LLM トークン消費を最小化できる（データが増えても照合コストが膨らまない）。

カーソル前進を取得と分離（`commit_cursor`）する理由は **取りこぼし防止**。`get_quoted_posts` の時点でカーソルを進めると、その後の要約・Notion 書き込みが失敗した差分が次回返らず失われる。下流の成功を確認してから明示確定することで、失敗時は次回同じ差分を再取得できる。

ページング（`pagination_token`）は実装しない。差分が `max_results` を超えた場合、1 回の呼び出しで取りきれないが、`commit_cursor` で確定した位置から次回続きを拾えるため、定期実行で追いつく。

> 補足: X API には「同じリソースを 24 時間以内に再取得しても追加課金されない」重複排除の仕組みがあるため、再取得（取りこぼし時の手動巻き戻し含む）が X API のコストを増やすことは基本的にない。

## 8. トークン管理

- 保存先: `~/.atodeyomu-mcp/tokens.json`（パーミッション `600`）。
- 保持する値の例: `access_token` / `refresh_token` / `expires_at`（絶対時刻に正規化して保存すると判定が容易）/ `scope`。
- リフレッシュのたびに **新しい access / refresh token と有効期限で上書き** する（refresh token のローテーション対応）。
- リフレッシュには `CLIENT_ID` / `CLIENT_SECRET` が必要。これらは環境変数（`~/.mcp.json` の `env`）から渡す。トークン自体（`tokens.json`）とは別管理。
- 本サーバーはローカルタスク（同一 PC 上）で繰り返し実行される前提。

カーソルはトークンとは別ファイル（`~/.atodeyomu-mcp/cursor.json`、`{ "last_post_id", "updated_at" }`）で管理する。秘密情報ではないがライフサイクルが異なるためトークンと分離する。`commit_cursor` 実行時のみ上書きする。

## 9. 認証フロー（概略）

1. `atodeyomu-mcp auth` 実行 → 認可 URL 表示。
2. ユーザーがブラウザで認可 → X が `http://127.0.0.1:8787/callback?code=...&state=...` にリダイレクト。
3. `state` 検証 → `loginWithOAuth2()` でトークン取得 → `tokens.json` に保存。
4. 以降、MCP サーバーは起動・ツール呼び出し時に `tokens.json` を読み、必要なら自動リフレッシュ。

## 10. エラーハンドリング

| 状況 | 振る舞い |
| --- | --- |
| レート制限（429） | レート制限である旨と `Retry-After`（秒）の値をエラーメッセージに含めて返す。 |
| 認証エラー（401 / refresh token 失効） | 「`atodeyomu-mcp auth` を再実行してください」と明示したメッセージを返す。 |
| トークンファイル不在 | 同上（再認可を促す）。 |
| その他の X API エラー | **生のエラーレスポンスをそのまま転送しない**。内部 URL・トークン・ヘッダーが漏れないよう、ステータスコードと必要最小限のメッセージだけ抽出して返す。 |

## 11. セキュリティ / 非機能要件

- シークレット・トークンを **絶対にコミットしない**。秘密はリポジトリ外（`~/.mcp.json` の `env`、`~/.atodeyomu-mcp/tokens.json`）に置く。`.gitignore` に（保険として）`.env`・`tokens.json` 系を含める。
- `CLIENT_ID` / `CLIENT_SECRET` は、サーバー起動時は `~/.mcp.json` の `env`（環境変数）、認可時は `--client-id` / `--client-secret` フラグ（無ければ環境変数）で渡す。
- トークンファイルは `chmod 600`。
- `~/.mcp.json` には Client ID / Secret が平文で入るため、このファイルも秘密情報として扱う。
- エラーメッセージにトークン・内部 URL を含めない。

## 12. ビルド / 配布 / 実行

- `npm run build`（TypeScript → JS、`dist/` に出力）。`prepare` スクリプトで `npm install`・`npm publish`・git インストール時に自動実行される。
- npm に公開し（`npm publish`）、利用者は `~/.mcp.json` に `command: "npx"`, `args: ["-y", "atodeyomu-mcp"]`, `env: { CLIENT_ID, CLIENT_SECRET }` で登録する。
- 認可は `npx -y atodeyomu-mcp auth --client-id <ID> --client-secret <SECRET>` を一度だけ実行する。
- 詳細手順は README / docs/VERIFICATION.md。
