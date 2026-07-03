#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getQuotedPosts } from "./tools/get-quoted-posts.js";
import { commitCursor } from "./tools/commit-cursor.js";
import { getArticle } from "./tools/fetch-article.js";
import { loadTokens } from "./twitter-client.js";
import { runAuth } from "./auth.js";

// バージョンは package.json から読む（`npm version` で1箇所更新すれば全体に反映される）。
// dist/index.js から見て package.json はパッケージルート（../package.json）にある。
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version: string;
  }
).version;

function buildServer(): McpServer {
  const server = new McpServer({
    name: "atodeyomu-mcp",
    version: VERSION,
  });

  server.registerTool(
    "get_quoted_posts",
    {
      title: "Get quoted posts",
      description:
        "前回確定したカーソル以降の引用ポスト（あとで読む用の引用リツイート）と引用元コンテンツを取得する。カーソルは進めない。",
      inputSchema: {
        max_results: z.number().int().min(1).max(100).optional().describe("取得件数（既定20、最大100）。従来モード（limit 未指定）でのみ使用"),
        since_id: z.string().optional().describe("この id 以降を取得する。指定時はカーソルより優先される"),
        pagination_token: z
          .string()
          .optional()
          .describe(
            "前回のレスポンスの next_token。差分が max_results を超える場合、これを渡して呼び直すと続きのページを取得できる（同じ since_id 境界内でのページ送り）。従来モード用",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "指定すると、MCP 側で全ページを内部的に取得して古い順（id 昇順）に並べ、先頭 limit 件の引用ポストだけを返す。呼び出し側は差分全件をコンテキストに載せず、処理する古い N 件だけ受け取れる。返り値の has_more で残りがあるか分かる。max_results / pagination_token とは併用しない",
          ),
      },
    },
    async ({ max_results, since_id, pagination_token, limit }) => {
      try {
        const result = await getQuotedPosts({ max_results, since_id, pagination_token, limit });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "不明なエラーが発生しました。";
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "commit_cursor",
    {
      title: "Commit cursor",
      description:
        "下流処理（Notion 保存など）の成功を確認した後に呼び、取得位置カーソルを確定する。X API は呼ばない。",
      inputSchema: {
        post_id: z.string().describe("ここまで安全に保存済みである最後の post id"),
      },
    },
    async ({ post_id }) => {
      try {
        const result = commitCursor({ post_id });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "不明なエラーが発生しました。";
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "fetch_article",
    {
      title: "Fetch article",
      description:
        "引用元ポストに含まれる URL（t.co 短縮 URL 可）を解決し、リンク先の記事本文を抽出して返す。リダイレクトを追い、最終 URL が X の別ポストだった場合やペイウォール・非記事ページは本文を返さず status で通知する。X には書き込まない。",
      inputSchema: {
        url: z.string().describe("記事の URL。quoted_post.text に含まれる t.co や記事 URL をそのまま渡してよい"),
      },
    },
    async ({ url }) => {
      try {
        const result = await getArticle({ url });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "不明なエラーが発生しました。";
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    },
  );

  return server;
}

async function startServer(): Promise<void> {
  try {
    loadTokens();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** `--name value` と `--name=value` の両形式に対応してフラグ値を取り出す。 */
function parseFlag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) return args[i + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }
  if (command === "auth") {
    const args = process.argv.slice(3);
    // フラグ優先、無ければ環境変数にフォールバック
    const clientId = parseFlag(args, "--client-id") ?? process.env.CLIENT_ID;
    const clientSecret = parseFlag(args, "--client-secret") ?? process.env.CLIENT_SECRET;
    await runAuth(clientId, clientSecret);
    return;
  }
  await startServer();
}

main().catch((error) => {
  console.error("起動に失敗しました:", error instanceof Error ? error.message : error);
  process.exit(1);
});
