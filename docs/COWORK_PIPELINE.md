# Cowork 連携パイプライン（ゴールまでの手順）

> ゴール: Cowork のスケジュールタスクが定期的に atodeyomu-mcp から「あとで読む」引用ポストを取得し、要約して Notion に記録する。本書はそこに到達するための手順と、スケジュールタスクに渡すプロンプトをまとめたもの。

## 0. 責務の再確認

atodeyomu-mcp（本サーバー）がやるのは **構造的な引用ポスト抽出と取得位置管理だけ**。以下は明示的にこのサーバーの責務外であり、Cowork のスケジュールタスク（プロンプト側）が担う。

| atodeyomu-mcp がやる | Cowork タスクがやる |
| --- | --- |
| 引用ポストの構造的判定・引用元取得（`get_quoted_posts`） | 本文に「あとで読む」を含むかのキーワード判定 |
| 取得位置カーソルの確定（`commit_cursor`） | 引用元コンテンツの要約 |
| トークン管理 | Notion への書き込み |

この境界は [docs/DESIGN.md](./DESIGN.md) §1, [docs/SPEC.md](./SPEC.md) §2 の設計どおりで、変更していない。

## 1. 前提: MCP 自体の動作確認

[docs/VERIFICATION.md](./VERIFICATION.md) の手順を一度通し、`get_quoted_posts` / `commit_cursor` が手元で正しく動くことを確認しておく。これが済んでいないと、スケジュールタスクを動かしても何が失敗しているのか分からなくなる。

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
- **頻度と取りこぼし**: `max_results` 既定20件・ページング未実装のため（[docs/SPEC.md](./SPEC.md) §6.2 参照）、引用ポストの頻度がスケジュール間隔に対して多すぎると一度に取りきれない可能性がある。差分は `commit_cursor` で確定した位置から次回も拾われるので消えはしないが、反映が遅れる。頻度を上げるか `max_results` を増やす調整が必要になったら検討する。
- **失敗時の安全性**: Notion 書き込みが一部失敗しても、`commit_cursor` を呼ばない/部分的な id で呼ぶことで取りこぼしが起きない設計になっている（[docs/SPEC.md](./SPEC.md) §6.1）。Cowork プロンプトの 3-d・4・5 の手順を変えないこと。
- **データベースの再作成**: Notion データベースを削除・再作成した場合、データソースURLが変わる。`docs/templates/cowork-prompt.md` のプレースホルダを書き換え、登録済みのスケジュールタスクの `prompt` も `update_scheduled_task` で更新すること。
