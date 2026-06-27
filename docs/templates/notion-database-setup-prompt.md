Notionワークスペースに、atodeyomu-mcpの「あとで読む」引用ポストを記録するためのデータベースを新規作成してください。

- タイトル: あとで読むログ
- 作成場所: ワークスペースのトップレベル（特に指定がなければ）
- スキーマ:

```sql
CREATE TABLE (
  "Title" TITLE,
  "Summary" RICH_TEXT,
  "Quote Comment" RICH_TEXT,
  "Quoted Text" RICH_TEXT,
  "Author" RICH_TEXT,
  "Source URL" URL,
  "Quoted URL" URL,
  "Posted At" DATE,
  "Post ID" RICH_TEXT,
  "Status" SELECT('Unread':red, 'Read':green)
)
```

作成できたら、返ってきたデータベースのURLと、データソースURL（`collection://...` の形式）を教えてください。
