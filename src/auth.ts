import { createServer } from "node:http";
import { TwitterApi } from "twitter-api-v2";
import { saveTokens } from "./twitter-client.js";

const PORT = 8787;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = ["tweet.read", "users.read", "offline.access"];

/**
 * OAuth 2.0 PKCE 認可フローを実行し、トークンを `~/.atodeyomu-mcp/tokens.json` に保存する。
 * `atodeyomu-mcp auth` サブコマンドから一度だけ呼ばれる。
 * 資格情報は呼び出し側（index.ts）が `--client-id` / `--client-secret` フラグ、
 * もしくは環境変数から解決して渡す。
 */
export function runAuth(clientId?: string, clientSecret?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!clientId || !clientSecret) {
      reject(
        new Error(
          "Client ID / Secret が指定されていません。次のように渡してください:\n  npx -y atodeyomu-mcp auth --client-id <ClientID> --client-secret <ClientSecret>",
        ),
      );
      return;
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
          res
            .writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
            .end("state が一致しません。認可をやり直してください。");
          server.close();
          reject(new Error("state が一致しませんでした。認可をやり直してください。"));
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

        res
          .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
          .end("認可が完了しました。このタブを閉じて構いません。");
        console.log("トークンを ~/.atodeyomu-mcp/tokens.json に保存しました。");
        server.close();
        resolve();
      } catch (error) {
        res
          .writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
          .end("認可処理に失敗しました。ターミナルのログを確認してください。");
        server.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    server.listen(PORT, () => {
      console.log(`コールバック待機中... (http://127.0.0.1:${PORT}/callback)`);
    });
  });
}
