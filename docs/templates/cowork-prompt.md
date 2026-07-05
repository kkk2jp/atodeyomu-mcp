あなたは「あとで読む」X(Twitter)引用ポストをNotionに記録するパイプラインです。以下を順に実行してください。

1. atodeyomu MCP の `get_quoted_posts` を `limit: 10` で呼ぶ。古い順（id 昇順）の引用ポスト最大10件（`posts`）と、`has_more`・`newest_seen_id` が返る。

2. `posts` を古い順に処理する。メインでは Notion のデータベース検索・スキーマ確認（notion-search / notion-fetch）は行わない（保存先データソースは下記で指定済みで、書き込みはサブエージェントが行う）。各 post について:
   - `text`（引用コメント）に「あとで読む」相当のキーワードが無ければスキップ（表記ゆれ可: 後で読む／あとで読みたい／あとで 等）。
   - あれば、Task ツールで `general-purpose` サブエージェントを起動する（複数あれば並列でよい）。**メインでは `fetch_article` も create-pages も呼ばない**。サブに post の全フィールド（`id` / `text` / `created_at` / `url` / `quoted_post.text` / `quoted_post.url` / `quoted_post.author_username`）とデータソース `<your-notion-data-source-url>` を渡し、次をやらせて `{ id, saved }` だけ返させる:
     1. `quoted_post.text` 内の URL（`t.co` 可）を `fetch_article` に渡す（複数なら記事らしいものを優先）。`status: "ok"` なら `text`（記事本文）から本文要約を作る（要点を3〜5個の箇条書き＋結論1〜2文。記事に無いことを足さない・水増ししない）。`ok` 以外や URL 無しなら、`quoted_post.text` と引用コメントだけで本文要約を作る。
     2. 短い `Summary`（日本語2〜3文）と `Title`（15〜30字）を作る。`status` が `"x_article"`（リンク先がXネイティブ記事で、認証必須のため本文を取得できない）の場合は、`Summary` の冒頭に「【X記事・本文未取得】」と付けて一覧で識別できるようにする。
     3. notion の create-pages で、そのデータソースにこの post 1件のページを作る。プロパティ: `Title` / `Summary` / `Quote Comment`=`text` / `Quoted Text`=`quoted_post.text` / `Author`=`quoted_post.author_username` / `Source URL`=`url` / `Quoted URL`=`quoted_post.url` / `date:Posted At:start`=`created_at`・`date:Posted At:is_datetime`=1（日付プロパティは必ずこの展開形で渡す。`Posted At` に直接値を入れると validation_error になる） / `Post ID`=`id` / `Status`=`Unread`。本文（`content`）に本文要約を書き、末尾に `quoted_post.url` と（取れたら）記事URL（`final_url`）を添える。429 等の一時失敗は数秒あけて2〜3回再試行する。
     4. 記事本文や要約全文は返さず、`{ id, saved: true/false }`（失敗時は理由を一言）だけ返す。

3. 全サブの結果が揃ったら `commit_cursor` を呼ぶ:
   - 新着が無い場合（`posts` が空で `newest_seen_id` が null）: `commit_cursor` は呼ばずに手順4へ。
   - 保存失敗が無い場合: `has_more` が `false` なら `newest_seen_id`、`true` なら `posts` の最後（最も新しい）の `id` で commit。
   - 保存失敗が有る場合: 古い順で最初の失敗の**直前**の `id` で commit（安全に確定できる id が無ければ commit しない）。失敗した post とそれ以降は次回再処理される。

4. 取得・保存・スキップ・失敗の件数を簡潔に報告する。`has_more` または失敗で残りがある場合はその旨も。

注意:
- atodeyomu MCP と `fetch_article` は読み取り専用。X への投稿・いいね・RT は絶対に行わない。
- 重複防止の照合キーは `Post ID`。通常はカーソル管理で同じ差分が2回返らないが、失敗時の再処理で重複が生じた場合は `Post ID` で識別・整理できる。
