# Cowork 連携パイプライン（ゴールまでの手順）

> ゴール: Cowork のスケジュールタスクが定期的に atodeyomu-mcp から「あとで読む」引用ポストを取得し、要約して Notion に記録する。本書はそこに到達するための手順と、スケジュールタスクに渡すプロンプトをまとめたもの。

## 0. 責務の再確認

atodeyomu-mcp（本サーバー）がやるのは **構造的な引用ポスト抽出・記事本文の取得抽出・取得位置管理**。以下は明示的にこのサーバーの責務外であり、Cowork のスケジュールタスク（プロンプト側）が担う。

| atodeyomu-mcp がやる | Cowork タスクがやる |
| --- | --- |
| 引用ポストの構造的判定・引用元取得（`get_quoted_posts`） | 本文に「あとで読む」を含むかのキーワード判定 |
| 記事 URL のリダイレクト解決・本文抽出（`fetch_article`） | 取得した記事本文・引用元本文の**要約** |
| 取得位置カーソルの確定（`commit_cursor`） | Notion への書き込み |
| トークン管理 | どの差分を保存するかの判断・確定タイミングの指示 |

責務境界の線引きは [docs/DESIGN.md](./DESIGN.md) §1, [docs/SPEC.md](./SPEC.md) §2 のとおり。**記事の fetch（リダイレクト解決＋本文抽出）は MCP 側（`fetch_article`）が担う**が、**要約は引き続き呼び出し側**という分担。以前は記事 fetch も呼び出し側（web_fetch）の責務だったが、Cowork 環境の web_fetch が `t.co` のリダイレクトを解決できず記事取得に失敗していたため、fetch と本文抽出を MCP に寄せた。

## 1. 前提: MCP 自体の動作確認

[docs/VERIFICATION.md](./VERIFICATION.md) の手順を一度通し、`get_quoted_posts` / `commit_cursor` / `fetch_article` が手元で正しく動くことを確認しておく。これが済んでいないと、スケジュールタスクを動かしても何が失敗しているのか分からなくなる。

## 2. Notion 側の保存先を用意する

「あとで読むログ」データベースを自分のNotionワークスペースに作成する。

1. [docs/templates/notion-database-setup-prompt.md](./templates/notion-database-setup-prompt.md) の内容を**そのまま全部コピー**して、Claude（Notion MCP が使える状態）に渡す。
2. Claude がデータベースを作成すると、データベースのURLと**データソースURL**（`collection://xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` の形式）が返ってくる。このデータソースURLを控えておく。これが §3 で `cowork-prompt.md` のプレースホルダ `<your-notion-data-source-url>` に差し込む実値になる。

作成されるプロパティは次のとおり。

| プロパティ名 | 型 | 用途 |
| --- | --- | --- |
| `Title` | title | 自分の引用コメントの冒頭など、一覧で識別しやすい短い見出し |
| `Summary` | text | 引用元コンテンツの要約（Cowork タスクが生成） |
| `Quote Comment` | text | 自分が付けた引用コメント全文（`posts[].text`） |
| `Quoted Text` | text | 引用元の本文（`posts[].quoted_post.text`） |
| `Author` | text | 引用元の著者 username（`posts[].quoted_post.author_username`） |
| `Source URL` | url | 自分の引用ポストの URL（`posts[].url`） |
| `Quoted URL` | url | 引用元ポストの URL（`posts[].quoted_post.url`） |
| `Posted At` | date | 自分が引用ポストした日時（`posts[].created_at`） |
| `Post ID` | text | `posts[].id`。重複保存防止のための照合キー |
| `Status` | select (`Unread`/`Read`) | 既定値 `Unread`。読んだら手動で `Read` に変更する運用 |

上記プロパティに加えて、ページ本文（Notion の `content`）にも本文要約（記事の要点を箇条書き＋結論でまとめたもの）を書き込む。引用元ポストの本文にリンクがあれば `fetch_article` で取得して要約し、無ければ引用ポスト本文とコメントから要約を作る（`docs/templates/cowork-prompt.md` 手順 2-c・2-d）。

既に同名のデータベースが存在する場合や、ワークスペース直下ではなく特定の親ページの配下に作りたい場合は、§2-1 でClaudeに渡す前にプロンプトの「作成場所」の行を書き換えるか、Claude への依頼時に一言補足すればよい。

## 3. Cowork に渡すプロンプトを用意する

[docs/templates/cowork-prompt.md](./templates/cowork-prompt.md) を開き、次のプレースホルダを自分の値に書き換える。

| プレースホルダ | 書き換える値 | 確認方法 |
| --- | --- | --- |
| `<your-notion-data-source-url>` | §2-2 で控えたデータソースURL（`collection://...`） | Notion DB作成時にClaudeから返ってきた値をそのまま使う |

書き換えたら、ファイルの内容を全部コピーする。これが `create_scheduled_task` の `prompt` に渡す値になる。

## 4. スケジュールタスクとして登録する

`schedule` スキル、または `scheduled-tasks` MCP（`create_scheduled_task`）でタスクを登録する。スケジュールタスクは **Claude（Cowork）アプリが起動している間に実行**され、MCP 設定ファイル（`claude_desktop_config.json`）に登録された MCP サーバー（atodeyomu, notion）にそのままアクセスできる。クラウド専用エージェントではないので、ローカルの OAuth トークン（`~/.atodeyomu-mcp/tokens.json`）に依存する atodeyomu-mcp の前提（[docs/DESIGN.md](./DESIGN.md) §8「ローカルタスク前提」）と矛盾しない。

手順:

1. 実行頻度を決める（例: 毎日朝9時 `0 9 * * *`、6時間おき `0 */6 * * *` など）。引用ポストする頻度に応じて調整する。
2. `schedule` スキルを使うか、`create_scheduled_task` を次のように呼ぶ。

   - `taskId`: `atodeyomu-to-notion` など
   - `cronExpression`: 決めた頻度（ローカルタイムゾーンで評価される）
   - `prompt`: §3 で書き換えた `docs/templates/cowork-prompt.md` の内容全文
   - `description`: `"あとで読む引用ポストを取得してNotionに保存"`

3. 初回は cron 登録前に、同じプロンプトを手動で一度実行してみて、想定どおり Notion にページが作られ、`commit_cursor` が呼ばれることを確認する。最初の実行で問題なければスケジュール化する。

## 5. 運用上の注意

- **キーワード判定はゆるめに持つ**: 「あとで読む」の表記ゆれ（後で読む／あとで読みたい等）を許容するよう、プロンプト内で明示している。判定基準を厳格にしたい場合はプロンプトの該当箇所を調整する。
- **要約の質**: 要約はスケジュールタスク（Cowork 側）の責務であり、atodeyomu-mcp は関与しない。要約の文体・長さを変えたい場合はプロンプトの該当箇所だけ直せばよく、MCP サーバーの変更は不要。
- **引用元コンテンツの3パターンと本文要約**: ページ本文の要約（記事の要点を箇条書き＋結論でまとめた本文要約）の材料は、引用元ポストの内容に応じて次の3パターンがある。
  - **外部記事URL**（引用元が Zenn / Qiita / ブログ等の記事URLを貼っている）: `cowork-prompt.md` 手順 2-b のサブエージェントが、`quoted_post.text` に含まれる URL（`t.co` 短縮URL でよい）を atodeyomu MCP の `fetch_article` に渡す。MCP 側がリダイレクトを解決して最終記事URLの本文を抽出し、`status: "ok"` なら `text`（抽出済み本文）を返すので、サブエージェントがそれを要約して本文要約にし、短い要約だけをメインに返す。**引用ポストの大半はこれ**。従来 Cowork の web_fetch が `t.co` を解決できず失敗していた問題への恒久対応で、fetch と本文抽出が MCP 側に移った（§0 参照）。
  - **長文ポスト**（引用元ポスト自体がX長文ポスト機能で書かれている）: `get_quoted_posts` が `note_tweet` から全文を取得するため、`quoted_post.text` に全文が入る（切り詰めなし）。追加対応不要。
  - **別ポストの入れ子引用**（引用元が一言コメント＋別Xポストへのリンクだけ）: そのリンク先ポストの本文はパイプラインでは取得できない。`fetch_article` にそのリンクを渡しても `status: "x_post"` で弾かれる（MCP 側は入れ子の2段展開を行わず、孫ポストの本文取得はしない。[docs/DESIGN.md](./DESIGN.md) §1・§3 の「引用ポスト→引用元の1段取得」を維持するため）。**引用ポストする段階で、中間ポストではなく中身のある一次ポスト（記事URLを貼っているポストや長文ポスト本体）を直接引用する運用で回避する**方針。
- **コンテキスト肥大対策＋高速化（サブエージェント隔離）**: 記事本文（1件で数千〜1万数千字）や要約全文をメイン会話に積み上げると、多数処理時にコンテキストが膨張し、途中の文脈圧縮で「最後に安全に保存できた id」を見失って取りこぼし・重複保存が起きうる。またメインが1件ずつ直列に Notion 書き込みをすると、そのフェーズが遅い。これを避けるため、`cowork-prompt.md` 手順 2-b は**記事の取得（`fetch_article`）・要約・Notion 書き込みまでを post ごとにサブエージェント（Task ツールの `general-purpose`）へ丸ごと任せ**、メインには各サブから「`id` と保存成否」だけを返させる。記事全文も要約全文もサブエージェント内だけに存在し、メインのコンテキストには載らない。サブエージェントは並列起動できるので書き込みも並列化され、メインの直列書き込みより速い。メインは `commit_cursor` によるカーソル確定だけを担う。この構成ができるのは、スケジュールタスク環境に `Task` ツールと `general-purpose` エージェント（全ツールアクセス、`fetch_article` と `notion-create-pages` を呼べる）があるため。
- **1回の実行あたりの処理件数上限**: サブエージェント隔離に加えた安全弁として、`cowork-prompt.md` 手順1は `get_quoted_posts` に `limit: 10` を渡し、**MCP 側で古い順10件に絞って**受け取る。以前のようにプロンプト側で保存件数を数えて打ち切るのではなく、そもそも 10 件しかメインに返らないので、差分全件をコンテキストに載せずに済む。10 件を超える残りは、`get_quoted_posts` が返す `has_more` を見て `commit_cursor` を確定し、次回以降の実行で消化される（`has_more: true` なら返ってきた `posts` の最後の id を commit）。古い順に処理して「保存できた最後の id」を commit するため、上限で区切っても取りこぼしは起きない。件数を変えたい場合は手順1の `limit` の値を変えるだけでよい（MCP の再登録・再publish は不要）。
- **頻度と取りこぼし**: `get_quoted_posts` は `limit` モードで、MCP 側が**内部でページ送りを繰り返して全差分を集め、引用ポストを古い順にソートして先頭 N 件だけ**を返す（[docs/SPEC.md](./SPEC.md) §6.2 参照）。差分が溜まっていても呼び出し側は 1 回呼ぶだけでよく、ページ送りループを組む必要はない。実際にメインが受け取り保存するのは `limit`（10件）までで、残りは次回以降に回る。いずれの場合も失敗・打ち切り時は `commit_cursor` で確定した位置から次回拾われるので消えることはない。
- **失敗時の安全性**: サブエージェントの Notion 書き込みが一部失敗しても、`commit_cursor` を「古い順で最初の failed の直前まで」で呼ぶ（または1件も安全に確定できなければ呼ばない）ことで取りこぼしが起きない設計になっている（[docs/SPEC.md](./SPEC.md) §6.1）。Cowork プロンプトの 手順3・4（`has_more` と failed に応じたカーソル確定の分岐）を変えないこと。failed より新しい保存済み post が再処理されると重複しうるが、`Post ID` で識別できる（手順末尾の注意参照）。
- **データベースの再作成**: Notion データベースを削除・再作成した場合、データソースURLが変わる。`docs/templates/cowork-prompt.md` のプレースホルダを書き換え、登録済みのスケジュールタスクの `prompt` も `update_scheduled_task` で更新すること。
