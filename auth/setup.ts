import "dotenv/config";
import { createServer } from "node:http";
import { TwitterApi } from "twitter-api-v2";
import { saveTokens } from "../src/twitter-client.js";

const PORT = 8787;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = ["tweet.read", "users.read", "offline.access"];

async function main() {
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("CLIENT_ID / CLIENT_SECRET が .env に設定されていません。.env.example を参考に .env を作成してください。");
    process.exit(1);
  }

  const client = new TwitterApi({ clientId, clientSecret });
  const { url, state, codeVerifier } = client.generateOAuth2AuthLink(REDIRECT_URI, {
    scope: SCOPES,
  });

  console.log("以下の URL をブラウザで開いて認可してください:");
  console.log(url);

  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "", REDIRECT_URI);
      if (requestUrl.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const code = requestUrl.searchParams.get("code");
      const returnedState = requestUrl.searchParams.get("state");

      if (!code || !returnedState || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("state が一致しません。認可をやり直してください。");
        server.close();
        process.exit(1);
        return;
      }

      const { accessToken, refreshToken, expiresIn, scope } = await client.loginWithOAuth2({
        code,
        codeVerifier,
        redirectUri: REDIRECT_URI,
      });

      if (!refreshToken) {
        throw new Error("refresh_token が取得できませんでした。offline.access スコープを確認してください。");
      }

      saveTokens({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: Date.now() + expiresIn * 1000,
        scope: scope.join(" "),
      });

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("認可が完了しました。このタブを閉じて構いません。");
      console.log("トークンを ~/.atodeyomu-mcp/tokens.json に保存しました。");
      server.close();
      process.exit(0);
    } catch (error) {
      console.error("認可処理に失敗しました:", error instanceof Error ? error.message : error);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("認可処理に失敗しました。ターミナルのログを確認してください。");
      server.close();
      process.exit(1);
    }
  });

  server.listen(PORT, () => {
    console.log(`コールバック待機中... (http://127.0.0.1:${PORT}/callback)`);
  });
}

main();
