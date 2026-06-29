#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getQuotedPosts } from "./tools/get-quoted-posts.js";
import { commitCursor } from "./tools/commit-cursor.js";
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
        max_results: z.number().int().min(1).max(100).optional().describe("取得件数（既定20、最大100）"),
        since_id: z.string().optional().describe("この id 以降を取得する。指定時はカーソルより優先される"),
      },
    },
    async ({ max_results, since_id }) => {
      try {
        const result = await getQuotedPosts({ max_results, since_id });
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
