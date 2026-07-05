# atodeyomu-mcp 設計書

> このドキュメントは Claude Code に実装を依頼する際の入力（設計仕様）です。実装時はこの設計を正とし、曖昧な点が出た場合のみ確認してください。

## 1. 概要

X (Twitter) で「あとで読む」目的の引用リツイートを検出するための、**読み取り専用**の MCP サーバー。TypeScript で実装する。個人の知識管理パイプライン（Claude（Cowork）→ Notion）から、本サーバーが公開するツール `get_quoted_posts` を呼び出して使う。

本サーバーの責務は **「引用リツイートかどうか」という構造的判定（`referenced_tweets.type === "quoted"`）と、引用元コンテンツの取得**、**引用元ポストに含まれる URL を解決して記事本文を抽出すること**（`fetch_article`）、および **取得位置（カーソル）のローカル管理** のみ。キーワード判定・要約・Notion への書き込みは呼び出し側（Cowork のタスク）の責務であり、本サーバーには実装しない。記事本文の **fetch と抽出は本サーバー**（`fetch_article`）が担うが、その本文の **要約は呼び出し側** の責務である（`fetch_article` は抽出済み本文テキストを返すのみで要約はしない）。

下流（Notion 照合・要約）のコストを抑えるため、本サーバーは前回取得位置をローカルに記録し、X API の `since_id` で **差分だけ** を返す。カーソルの前進は取得時に自動では行わず、呼び出し側が下流処理（Notion 書き込み）の成功を確認してから `commit_cursor` ツールで明示的に確定する（取りこぼし防止）。

## 2. 技術スタック

| 項目 | 採用 |
| --- | --- |
| 言語 | TypeScript |
| ランタイム | Node.js 20+ |
| MCP SDK | `@modelcontextprotocol/sdk`（stdio transport） |
| X API クライアント | `twitter-api-v2`（X API v2、OAuth 2.0 PKCE 対応） |
| 記事本文抽出 | `@mozilla/readability` + `linkedom`（`fetch_article` で HTML から本文を抽出） |
| パッケージ管理 | npm |

## 3. スコープ（厳守）

**実装するもの**

- ツール `get_quoted_posts`（差分取得）・`commit_cursor`（カーソル確定）・`fetch_article`（記事本文の取得・抽出）の 3 つ。
- OAuth 2.0 Authorization Code + PKCE による認可フロー（`src/auth.ts`、`atodeyomu-mcp auth` サブコマンド）。
- トークンの読み込み・自動リフレッシュ・ファイル書き戻し。
- 取得位置カーソル（`last_post_id`）のローカル読み書き（`since_id` 差分取得の根拠は §7）。
- ページング（`pagination_token` / `next_token`）による複数ページの取得（§6.1・§7）。
- 引用元ポストに含まれる URL（`t.co` 短縮 URL 可）のリダイレクト解決と記事本文の抽出（`fetch_article`、§6.7）。要約は行わない（抽出済み本文を返すだけ）。

**実装しないもの（明示的に除外）**

- 投稿・いいね・リツイート・フォローなど **書き込み系の機能は一切実装しない**（X への書き込みの意。カーソルファイルへのローカル書き込みは行う）。
- 「本文に“あとで読む”を含むか」という **キーワード判定は実装しない**（呼び出し側の責務）。
- **要約は実装しない**（`fetch_article` で記事本文の fetch と抽出までは行うが、要約は呼び出し側の責務）。Notion 連携ロジックも実装しない。
- **引用元ポストがさらに別ポストを引用している場合（入れ子引用）の2段目以降の展開は実装しない**。取得するのは「自分の引用ポスト → その引用元ポスト」の1段のみ（§6.5）。引用元がさらに別ポストへのポインタになっているケースは、利用者が引用ポストする段階で中身のある一次ポストを直接引用する運用で回避する前提とし、MCP 側で2回目の tweets lookup による孫ポスト解決は行わない（API 呼び出し増・出力スキーマのネスト化・責務境界の変更を避けるため）。

## 4. ディレクトリ構成

```
atodeyomu-mcp/
├── src/
│   ├── index.ts              # CLI エントリ兼 MCP サーバー本体（bin）。引数で auth/サーバーを分岐
│   ├── auth.ts               # OAuth 認可フロー（`atodeyomu-mcp auth` サブコマンドから呼ぶ）
│   ├── twitter-client.ts     # トークン読込・リフレッシュ・API 呼び出し
│   ├── cursor.ts             # カーソル(last_post_id)の読み書き
│   ├── article.ts            # URL リダイレクト解決 + 記事本文抽出（readability + linkedom）
│   └── tools/
│       ├── get-quoted-posts.ts  # get_quoted_posts ツールの実装本体
│       ├── commit-cursor.ts     # commit_cursor ツールの実装本体
│       └── fetch-article.ts     # fetch_article ツールの実装本体（article.ts を呼ぶ薄いラッパ）
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
- `fetchUserTweets(userId, max_results, since_id?, pagination_token?)`: 自分のタイムラインを取得する（パラメータは §6）。`since_id` は与えられた場合のみクエリに付与する。`pagination_token` も同様に、与えられた場合のみクエリに付与する（ページ送り用）。

### 5.3 `src/cursor.ts`（カーソル層）

取得位置カーソルのローカル永続化を担う。トークンとは別ファイルで管理する。

- 保存先: `~/.atodeyomu-mcp/cursor.json`。中身は `{ "last_post_id": "<string>", "updated_at": "<ISO8601>" }`。
- 秘密情報ではないが、`~/.atodeyomu-mcp/` 配下に置く（パーミッションはトークンに合わせて `600` でよい）。
- `loadCursor()`: ファイルを読み、`last_post_id` を返す。存在しなければ `null`（＝初回実行 → `since_id` なしで呼び出し、タイムラインの直近 `max_results` 件を取得）。
- `saveCursor(post_id)`: `last_post_id` と `updated_at` を書き込む（上書き）。`commit_cursor` から呼ぶ。

### 5.4 `src/tools/get-quoted-posts.ts`（ツール実装）

`get_quoted_posts` の入出力定義とロジック本体。カーソルを読み、クライアント層を使い、レスポンスを整形する（§6.1〜6.5）。**カーソルの前進は行わない。** `limit` モードでは内部で全ページ取得（`fetchUserTweets` を `next_token` が尽きるまで、または最大20ページ繰り返す）し、引用ポストを id 昇順にソートして先頭 `limit` 件だけ返す。id は数字文字列で `Number` では桁あふれするため、昇順ソートは `BigInt` 比較で行う（ヘルパー `buildPosts`／`sortByIdAsc`）。

### 5.5 `src/tools/commit-cursor.ts`（ツール実装）

`commit_cursor` の入出力定義。受け取った `post_id` を `saveCursor()` でカーソルファイルに確定する（§6.6）。

### 5.6 `src/article.ts`（記事取得・抽出層）

URL のリダイレクト解決と記事本文抽出を担う。X API とは独立（トークン不要）。`fetchArticle(url)` を公開する（§6.7）。

- リダイレクトを **手動追従**（`redirect: "manual"`）し、最大 5 回まで `Location` を辿る。手動にするのは、途中で X の個別ポスト（`/status/数字`）や X ネイティブ記事（`/i/article/`）に着地した時点で本文取得を打ち切るため。
- 各アクセス前に URL のプロトコルを検査し、`http:` / `https:` 以外（`javascript:`・`data:` など）は弾く。
- ホスト判定（`x.com` / `twitter.com` / `mobile.` 付き）は共通ヘルパー `isXHost(hostname)` で行い、パス判定は `isXStatusUrl`（`/status/数字` → `x_post`）と `isXArticleUrl`（`^/i/article/` → `x_article`）の 2 つに分ける。
- 途中または最終 URL が X / Twitter の個別ポスト（`/status/数字`）なら本文取得せず `status: "x_post"` で打ち切る（パターン2）。
- 途中または最終 URL が X ネイティブ記事（`x.com/i/article/…`。Premium+ の長文記事機能）なら、fetch せず `status: "x_article"` で打ち切る（`x_post` と同じ扱い方）。X API v2 に記事本文を返すエンドポイントが無く、Web からも認証必須のため fetch してもほぼ空の JS シェルページしか返らない。`detail` に「X ネイティブ記事は認証必須のため本文を取得できない」を入れ、`title` / `text` は空文字。
- それ以外は HTML を取得し、`linkedom` で DOM 化して `@mozilla/readability` で本文を抽出する。
- fetch ガード: タイムアウト 10 秒（`AbortController`）、レスポンスサイズ上限 2MB（超過分は読み捨て）、`content-type` に `html` を含まないものは `not_article` 扱い、User-Agent は `atodeyomu-mcp article fetcher (+https://github.com/kkk2jp/atodeyomu-mcp)` を明示。読み取り（GET）のみで書き込みはしない。

### 5.7 `src/tools/fetch-article.ts`（ツール実装）

`fetch_article` の入出力定義。受け取った `url` を `fetchArticle()` に渡すだけの薄いラッパ（§6.7）。

### 5.8 `src/index.ts`（CLI エントリ / サーバー本体）

- 先頭に shebang（`#!/usr/bin/env node`）を持つ実行可能エントリ（`package.json` の `bin`）。
- `process.argv[2]` を見て分岐する: `auth` なら `runAuth()`（§5.1）を実行、それ以外は MCP サーバーを起動する。
- stdio transport で MCP サーバーを起動する。
- 起動時にトークンを読み込む。
- `CLIENT_ID` / `CLIENT_SECRET` は環境変数（`process.env`）から読む。MCP クライアント（Cowork / Claude デスクトップアプリ）が MCP 設定ファイル `claude_desktop_config.json` の `env` で渡す前提。
- ツール `get_quoted_posts`・`commit_cursor`・`fetch_article` を登録する。
- X API を呼ぶツール（`get_quoted_posts`）では呼び出しのたびに `ensureFreshToken()` を通す。`commit_cursor` はローカルファイル書き込みのみ、`fetch_article` は外部サイトへの GET のみで、いずれも X API を呼ばない（トークン不要）。

## 6. ツール仕様

### 6.1 `get_quoted_posts` 入力パラメータ

| 名前 | 型 | 必須 | デフォルト | 制約 |
| --- | --- | --- | --- | --- |
| `limit` | number | 任意 | なし | 1〜50。指定すると **limit モード**（下記）で動作し、内部で全ページを取得したうえで **古い順（id 昇順）に先頭 `limit` 件だけ** を返す。`max_results` / `pagination_token` とは併用しない |
| `max_results` | number | 任意 | 20 | 1〜100。**従来モード用**（`limit` 未指定時のみ有効） |
| `since_id` | string | 任意 | （カーソル値） | 数字文字列。指定時はカーソルより優先し、その id 以降を取得（取りこぼし時の手動巻き戻し用）。両モード共通 |
| `pagination_token` | string | 任意 | なし | 前回のレスポンスの `next_token`。**従来モード用**（`limit` 未指定時のみ有効）。差分が `max_results` を超える場合、これを渡して呼び直すと同じ `since_id` 境界内で続きのページを取得できる |

カーソル解決の優先順位: 入力 `since_id` > `cursor.json` の `last_post_id` > なし（初回・`since_id` 省略）。両モード共通。

**limit モード（推奨経路）**: `limit` を指定すると、MCP が**内部で全ページを取得**（内部ページサイズ100・無限ループ防止のため最大20ページ）し、取得した引用ポストを **id 昇順（古い→新しい）にソートして先頭 `limit` 件だけ**返す。ページ送りは MCP 内部で完結するため、呼び出し側は 1 回呼ぶだけでよく、差分全件をコンテキストに載せずに「処理すべき古い N 件」だけを受け取れる。返り値の `next_token` は常に `null`、残りがあるかは `has_more` で判断する（§6.4・§7）。

**従来モード（後方互換）**: `limit` 未指定時は単一ページ（直近 `max_results` 件）を返し、続きは呼び出し側が `next_token` を `pagination_token` に渡してページ送りする。`since_id` がない場合、`since_id` パラメータを付けずに呼び出すため、X API はタイムラインの直近 `max_results` 件（既定20・最大100）のみを返す（§7）。

### 6.2 X API 呼び出し

エンドポイント: `GET /2/users/:id/tweets`（`:id` は自分の user id）

クエリパラメータ:

```
tweet.fields     = created_at,text,referenced_tweets,note_tweet
expansions       = referenced_tweets.id,referenced_tweets.id.attachments.media_keys,referenced_tweets.id.author_id
media.fields     = url,type
user.fields      = username
max_results      = <入力値>
since_id         = <解決済みカーソル>   # 値がある場合のみ付与
pagination_token = <指定時のみ>
```

`note_tweet` は、通常の文字数上限を超える「長いポスト」で本文が切り詰められないようにするためのフィールド。長いポストの場合、全文は `note_tweet.text` に入る（§6.4）。

### 6.3 絞り込みロジック

レスポンス `data` 配列のうち、`referenced_tweets` に **`type === "quoted"` を含むものだけ** を残す。リプライ（`replied_to`）・リツイート（`retweeted`）・通常投稿は除外する。

### 6.4 出力

最上位はオブジェクト。`posts` に絞り込んだ引用ポスト配列、`newest_seen_id` に「今回取得したタイムライン全体（引用以外も含む）の最大 id」を入れる。`newest_seen_id` は全件を正常処理できた場合に `commit_cursor` へ渡す値。新着が無ければ `posts` は空配列、`newest_seen_id` は `null`。`next_token` にはページングのための `pagination_token`（§6.1）を入れる。次のページが無ければ `null`（**limit モードでは常に `null`**）。`has_more` は「返した分の先にまだ未処理の引用ポストが残っているか」を示す boolean。

- **limit モード**: 内部で全ページを取得し、引用ポストを id 昇順にソートして先頭 `limit` 件を `posts` に入れる（`posts` は古い順）。`limit` を超える引用ポストがまだあれば `has_more = true`、返した分で全部なら `false`。`newest_seen_id` は内部ページングの1ページ目（最新ページ）の `meta.newest_id`（タイムライン全体の最大 id）。`next_token` は常に `null`。
- **従来モード**: 単一ページを返し、`has_more` は `next_token != null` と同値（次ページがあれば `true`）。

```jsonc
{
  "posts": [
    {
      "id": "string",                       // 自分の引用ポストの ID
      "text": "string",                     // 引用コメント本文。note_tweet があればそちらを優先（長文ポスト対応）
      "created_at": "string",               // ISO 8601
      "url": "https://x.com/{自分のusername}/status/{id}",
      "quoted_post": {
        "id": "string",                     // 引用元ポストの ID
        "text": "string",                   // 引用元本文。note_tweet があればそちらを優先（長文ポスト対応）
        "created_at": "string",
        "author_username": "string",        // includes.users から解決
        "url": "https://x.com/{author_username}/status/{id}",
        "media": [                          // includes.media から解決、なければ []
          { "url": "string", "type": "photo|video|animated_gif" }
        ]
      }
    }
  ],
  "newest_seen_id": "string | null",         // タイムライン全体の最大 id（引用以外も含む）
  "next_token": "string | null",             // 次ページがあれば pagination_token として渡す値。無ければ null（limit モードでは常に null）
  "has_more": true                            // 返した分の先にまだ未処理の引用ポストが残っているか
}
```

> `newest_seen_id` を「引用ポストの最大 id」ではなく「タイムライン全体の最大 id」にする理由: 引用以外の post もカーソルで「見た」扱いにし、次回 `since_id` で再取得しないため。`posts` 配列の各 `id` は時系列順（id が大きいほど新しい）であり、呼び出し側は部分成功時に「安全に保存できた最後の id」を選んで `commit_cursor` に渡せる。
>
> `text` / `quoted_post.text` は X API の `note_tweet` フィールドを優先する。通常の `text` は文字数上限を超える「長いポスト」で切り詰められるが、`note_tweet.text` には全文が入る。

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

### 6.7 `fetch_article` 仕様

引用元ポスト本文（`quoted_post.text`）に含まれる URL を解決し、リンク先の記事本文を抽出して返す。X API・カーソルには一切触れず、外部サイトへの GET のみ行う（トークン不要）。**要約はしない**（抽出済み本文テキストを返すだけ）。

想定ユースケースは「引用元ポストが外部記事 URL を貼っているケース（パターン1）」。Cowork タスクは返ってきた `text` を要約して Notion ページ本文にする。従来 Cowork 環境の web_fetch が `t.co` のリダイレクトを解決できず記事取得に失敗していた問題への恒久対応として、リダイレクト解決＋本文抽出を本サーバーが担う。

入力パラメータ:

| 名前 | 型 | 必須 | 制約 |
| --- | --- | --- | --- |
| `url` | string | 必須 | 記事の URL。`quoted_post.text` に含まれる `t.co` 短縮 URL や記事 URL をそのまま渡してよい |

処理:

1. リダイレクトを **手動追従**（最大 5 回）して最終 URL に解決する。`http:` / `https:` 以外のプロトコルは弾く。
2. 途中または最終 URL が X / Twitter の個別ポスト（`/status/数字` を含む URL）なら本文取得せず打ち切る（`status: "x_post"`）。X ネイティブ記事（`x.com/i/article/…`）も同様に fetch せず打ち切る（`status: "x_article"`）。
3. それ以外は HTML を取得し、`@mozilla/readability` + `linkedom` で本文を抽出する。

出力（JSON）:

```jsonc
{
  "final_url": "string",   // リダイレクトを追って到達した最終 URL
  "title": "string",        // 記事タイトル（取れなければ空文字）
  "text": "string",         // 抽出済み本文（status が ok 以外は空文字）
  "status": "ok | x_post | x_article | not_article | fetch_failed",
  "detail": "string"        // 任意。失敗時の補足（HTTP ステータス等。トークン・内部情報は含めない）
}
```

`status` の意味:

| status | 意味 | title / text |
| --- | --- | --- |
| `ok` | 記事本文を抽出できた | title あり（取れなければ空）、text あり |
| `x_post` | リダイレクト先が X の別ポスト（パターン2）。本文は取得しない | ともに空文字 |
| `x_article` | リダイレクト先が X ネイティブ記事（`x.com/i/article/…`）。認証必須のため本文は取得できない（`detail` に理由） | ともに空文字 |
| `not_article` | 取得できたが記事本文として抽出できなかった（画像・動画のみ、非 HTML、抽出結果が空等） | text は空文字 |
| `fetch_failed` | ネットワークエラー・非 HTTP・ペイウォール（HTTP エラー）・タイムアウト・リダイレクト超過等 | ともに空文字 |

> `x_post` は入れ子引用（パターン2）の別ポストを弾くだけで、**孫ポストの本文取得は行わない**（§3「実装しないもの」の 2 段展開しない方針と一致）。

## 7. カーソルによる差分取得の設計（`since_id`）

本サーバーはローカルカーソル（`last_post_id`）を持ち、X API の `since_id` で **前回以降の差分だけ** を取得する。これにより、下流の Notion 照合・要約に渡るデータ量が新着分に限定され、Notion 接続回数と LLM トークン消費を最小化できる（データが増えても照合コストが膨らまない）。

カーソル前進を取得と分離（`commit_cursor`）する理由は **取りこぼし防止**。`get_quoted_posts` の時点でカーソルを進めると、その後の要約・Notion 書き込みが失敗した差分が次回返らず失われる。下流の成功を確認してから明示確定することで、失敗時は次回同じ差分を再取得できる。

差分が `max_results` を超えた場合、1 回の呼び出しでは取りきれない。取得側には 2 つの経路がある。

**limit モード（推奨）**: `limit` を指定すると、MCP 側が内部で全ページを繰り、引用ポストを id 昇順にソートして**古い順に先頭 `limit` 件だけ**返す。呼び出し側はページ送りループを組む必要がなく、1 回呼ぶだけで「処理すべき古い N 件」と `has_more` を受け取れる。差分全件をコンテキストに載せずに済むため、大量バックログ時のコンテキスト肥大を避けられる。呼び出し側の想定フローは次のとおり。

1. `get_quoted_posts` を `limit: N` で 1 回だけ呼ぶ。返ってくる `posts` は古い順・最大 N 件。
2. 古い順に処理し、成功のたびに「安全に保存できた最後の id」を記録する。
3. 処理後、`commit_cursor` を次のように呼ぶ:
   - 全件処理でき `has_more: false`（今回の分でタイムライン全体を見終えた）→ `newest_seen_id` で確定。
   - 全件処理でき `has_more: true`（返した N 件の先にまだ残りがある）→ 返ってきた `posts` の**最後（最も新しい）の id** で確定。残りは次回実行が続きから処理する。
   - 保存エラーで中断 → 「安全に保存できた最後の id」で確定。1 件も保存できなければ `commit_cursor` を呼ばない。

**従来モード（後方互換）**: `limit` 未指定時はレスポンスの `next_token` を `pagination_token` として渡して呼び直すことで、同じ `since_id` 境界内の続きのページを取得できる（ページング）。呼び出し側の想定フローは次のとおり。

1. 1 回目は `pagination_token` なしで呼ぶ。
2. レスポンスに `next_token` があれば、それを次回呼び出しの `pagination_token` に渡して呼び直す。`next_token` が返らなくなるまで繰り返す。
3. 各回の `posts` は全て合算する。
4. `commit_cursor` に渡す `newest_seen_id` は、**1 回目（`pagination_token` 未指定）の呼び出しで返ってきた値**を使う。2 回目以降のページは過去方向へのページ送りであり、より新しい id を含まないため。

いずれのモードでも、ページングを使わず 1 回の呼び出しで完結させ、取りきれなかった古い引用ポストを `commit_cursor` で確定した位置から次回実行で拾う運用でもよい。

> 補足: X API には「同じリソースを 24 時間以内に再取得しても追加課金されない」重複排除の仕組みがあるため、再取得（取りこぼし時の手動巻き戻し含む）が X API のコストを増やすことは基本的にない。

## 8. トークン管理

- 保存先: `~/.atodeyomu-mcp/tokens.json`（パーミッション `600`）。
- 保持する値の例: `access_token` / `refresh_token` / `expires_at`（絶対時刻に正規化して保存すると判定が容易）/ `scope`。
- リフレッシュのたびに **新しい access / refresh token と有効期限で上書き** する（refresh token のローテーション対応）。
- リフレッシュには `CLIENT_ID` / `CLIENT_SECRET` が必要。これらは環境変数（MCP 設定ファイル `claude_desktop_config.json` の `env`）から渡す。トークン自体（`tokens.json`）とは別管理。
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
| `fetch_article` の記事取得失敗 | エラーとして throw せず、`status` で通知する（正常系）。ネットワークエラー・非 HTTP・ペイウォール（HTTP エラー）・タイムアウト・リダイレクト超過は `fetch_failed`、非 HTML・抽出結果が空は `not_article`、X の別ポストは `x_post`、X ネイティブ記事（認証必須で本文取得不可）は `x_article`。`detail` には HTTP ステータス等の最小限の補足のみを入れ、内部情報は含めない。呼び出し側は `ok` 以外を要約なしのフォールバックとして扱う（保存エラーにはしない）。 |

## 11. セキュリティ / 非機能要件

- シークレット・トークンを **絶対にコミットしない**。秘密はリポジトリ外（MCP 設定ファイル `claude_desktop_config.json` の `env`、`~/.atodeyomu-mcp/tokens.json`）に置く。`.gitignore` に（保険として）`.env`・`tokens.json` 系を含める。
- `CLIENT_ID` / `CLIENT_SECRET` は、サーバー起動時は MCP 設定ファイルの `env`（環境変数）、認可時は `--client-id` / `--client-secret` フラグ（無ければ環境変数）で渡す。
- トークンファイルは `chmod 600`。
- MCP 設定ファイル（`claude_desktop_config.json`）には Client ID / Secret が平文で入るため、このファイルも秘密情報として扱う。
- エラーメッセージにトークン・内部 URL を含めない。
- `fetch_article` は呼び出し側から渡された **任意 URL をサーバーサイドで fetch** する。悪用・過負荷・情報漏えいを避けるため次のガードを設ける: プロトコルは `http:` / `https:` 限定（`javascript:`・`data:` 等は拒否）、リダイレクト追従は最大 5 回、タイムアウト 10 秒、レスポンスサイズ上限 2MB、User-Agent は自身を正直に名乗る（`atodeyomu-mcp article fetcher (+https://github.com/kkk2jp/atodeyomu-mcp)`）。読み取り（GET）のみで対象サイトへ書き込みはしない。`detail` に HTTP ステータス等を入れる際もトークン・内部情報は含めない。

## 12. ビルド / 配布 / 実行

- `npm run build`（TypeScript → JS、`dist/` に出力）。`prepare` スクリプトで `npm install`・`npm publish`・git インストール時に自動実行される。
- npm に公開し（`npm publish`）、利用者は MCP 設定ファイル（Cowork なら `claude_desktop_config.json`）に `command: "npx"`, `args: ["-y", "atodeyomu-mcp"]`, `env: { CLIENT_ID, CLIENT_SECRET }` で登録する。
- 認可は `npx -y atodeyomu-mcp auth --client-id <ID> --client-secret <SECRET>` を一度だけ実行する。
- 利用手順は README / docs/VERIFICATION.md。
