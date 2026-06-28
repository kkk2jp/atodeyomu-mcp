import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TwitterApi, ApiResponseError, type TweetV2PaginableTimelineResult } from "twitter-api-v2";

const CONFIG_DIR = join(homedir(), ".atodeyomu-mcp");
const TOKENS_PATH = join(CONFIG_DIR, "tokens.json");

const REFRESH_MARGIN_MS = 60_000;

export interface TokenFile {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  scope: string;
}

export class ReauthRequiredError extends Error {
  constructor(message = "認証情報が無効です。`npx -y atodeyomu-mcp auth` を再実行してください。") {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

export class RateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number | null) {
    super(
      retryAfterSeconds != null
        ? `レート制限中です。${retryAfterSeconds}秒後に再試行してください。`
        : "レート制限中です。しばらく待ってから再試行してください。",
    );
    this.name = "RateLimitedError";
  }
}

export class TwitterApiCallError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "TwitterApiCallError";
  }
}

export function loadTokens(): TokenFile {
  if (!existsSync(TOKENS_PATH)) {
    throw new ReauthRequiredError(
      "トークンファイルが見つかりません。`npx -y atodeyomu-mcp auth --client-id <ClientID> --client-secret <ClientSecret>` を実行してください。",
    );
  }
  const raw = readFileSync(TOKENS_PATH, "utf-8");
  return JSON.parse(raw) as TokenFile;
}

export function saveTokens(tokens: TokenFile): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "環境変数 CLIENT_ID / CLIENT_SECRET が設定されていません。MCP 設定（Cowork なら claude_desktop_config.json）の env で渡してください。",
    );
  }
  return { clientId, clientSecret };
}

async function ensureFreshToken(): Promise<TokenFile> {
  const tokens = loadTokens();
  if (Date.now() < tokens.expires_at - REFRESH_MARGIN_MS) {
    return tokens;
  }

  const { clientId, clientSecret } = getCredentials();
  const refreshClient = new TwitterApi({ clientId, clientSecret });

  try {
    const { accessToken, refreshToken, expiresIn, scope } = await refreshClient.refreshOAuth2Token(
      tokens.refresh_token,
    );
    if (!refreshToken) {
      throw new ReauthRequiredError();
    }
    const updated: TokenFile = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Date.now() + expiresIn * 1000,
      scope: scope.join(" "),
    };
    saveTokens(updated);
    return updated;
  } catch (error) {
    if (error instanceof ApiResponseError && error.isAuthError) {
      throw new ReauthRequiredError();
    }
    throw error;
  }
}

async function getClient(): Promise<TwitterApi> {
  const tokens = await ensureFreshToken();
  return new TwitterApi(tokens.access_token);
}

let cachedOwnUser: { id: string; username: string } | null = null;

export async function getOwnUser(): Promise<{ id: string; username: string }> {
  if (cachedOwnUser) {
    return cachedOwnUser;
  }
  const client = await getClient();
  const { data } = await client.v2.me();
  cachedOwnUser = { id: data.id, username: data.username };
  return cachedOwnUser;
}

export async function fetchUserTweets(
  userId: string,
  maxResults: number,
  sinceId: string | null,
): Promise<TweetV2PaginableTimelineResult> {
  const client = await getClient();
  const paginator = await client.v2.userTimeline(userId, {
    max_results: maxResults,
    ...(sinceId ? { since_id: sinceId } : {}),
    "tweet.fields": ["created_at", "text", "referenced_tweets"],
    expansions: [
      "referenced_tweets.id",
      "referenced_tweets.id.attachments.media_keys",
      "referenced_tweets.id.author_id",
    ],
    "media.fields": ["url", "type"],
    "user.fields": ["username"],
  });
  return paginator.data;
}

/** Converts a raw API/auth error into a safe error that does not leak tokens or internal URLs. */
export function toSafeError(error: unknown): Error {
  if (error instanceof ReauthRequiredError || error instanceof RateLimitedError || error instanceof TwitterApiCallError) {
    return error;
  }
  if (error instanceof ApiResponseError) {
    if (error.isAuthError) {
      return new ReauthRequiredError();
    }
    if (error.rateLimitError) {
      const resetEpochSeconds = error.rateLimit?.reset;
      const retryAfterSeconds = resetEpochSeconds
        ? Math.max(0, resetEpochSeconds - Math.floor(Date.now() / 1000))
        : null;
      return new RateLimitedError(retryAfterSeconds);
    }
    return new TwitterApiCallError(error.code, `X API エラー (status ${error.code})`);
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error("不明なエラーが発生しました。");
}
