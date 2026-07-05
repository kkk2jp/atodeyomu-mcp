import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/** 記事取得の結果ステータス。呼び出し側（プロンプト）はこれを見てフォールバックを判断する。 */
export type FetchArticleStatus =
  | "ok" // 記事本文を抽出できた
  | "x_post" // リダイレクト先が X の別ポスト（パターン2）。本文は取得しない
  | "x_article" // リダイレクト先が X ネイティブの記事（x.com/i/article/…）。本文は認証必須のため取得できない
  | "not_article" // 取得できたが記事本文として抽出できなかった（画像・動画のみ等）
  | "fetch_failed"; // ネットワークエラー・非HTTP・ペイウォール・タイムアウト等

export interface FetchArticleResult {
  final_url: string; // リダイレクトを追って到達した最終 URL
  title: string; // 記事タイトル（取れなければ空文字）
  text: string; // 抽出済み本文（ok 以外は空文字）
  status: FetchArticleStatus;
  detail?: string; // 失敗時の補足（HTTP ステータス等。トークンや内部情報は含めない）
}

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const USER_AGENT = "atodeyomu-mcp article fetcher (+https://github.com/kkk2jp/atodeyomu-mcp)";

function isXHost(hostname: string): boolean {
  const host = hostname.replace(/^www\./, "");
  return host === "x.com" || host === "twitter.com" || host === "mobile.x.com" || host === "mobile.twitter.com";
}

/** 最終 URL が X / Twitter の個別ポスト（/status/）かどうか。パターン2の検出に使う。 */
function isXStatusUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return isXHost(u.hostname) && /\/status\/\d+/.test(u.pathname);
  } catch {
    return false;
  }
}

/** 最終 URL が X ネイティブの記事（x.com/i/article/…）かどうか。本文は認証必須のため Web からは取得できない。 */
function isXArticleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return isXHost(u.hostname) && /^\/i\/article\//.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * リダイレクトを手動で追って最終 URL とレスポンスを得る。
 * 手動追従にするのは、途中で X の個別ポストに着地した時点で本文取得を打ち切るため。
 */
async function fetchFollowingRedirects(
  startUrl: string,
): Promise<{ finalUrl: string; response: Response } | { xPostUrl: string } | { xArticleUrl: string } | { failed: string }> {
  let currentUrl = startUrl;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    // http/https 以外（javascript:, data: 等）は弾く
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return { failed: "invalid URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { failed: `unsupported protocol: ${parsed.protocol}` };
    }

    // 追従の途中でも X の個別ポストに着いたら打ち切り（パターン2）
    if (isXStatusUrl(currentUrl)) {
      return { xPostUrl: currentUrl };
    }
    // X ネイティブ記事も本文取得しない（認証必須。fetch してもシェルページしか返らない）
    if (isXArticleUrl(currentUrl)) {
      return { xArticleUrl: currentUrl };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
      });
    } catch (error) {
      clearTimeout(timeout);
      const message = error instanceof Error && error.name === "AbortError" ? "timeout" : "network error";
      return { failed: message };
    }
    clearTimeout(timeout);

    // リダイレクト応答なら Location を辿る
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        return { failed: `redirect without location (status ${res.status})` };
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!res.ok) {
      return { failed: `HTTP ${res.status}` };
    }

    // 到達点が X の個別ポスト / X ネイティブ記事なら本文取得しない
    if (isXStatusUrl(res.url || currentUrl)) {
      return { xPostUrl: res.url || currentUrl };
    }
    if (isXArticleUrl(res.url || currentUrl)) {
      return { xArticleUrl: res.url || currentUrl };
    }

    return { finalUrl: res.url || currentUrl, response: res };
  }

  return { failed: "too many redirects" };
}

/** レスポンス本文を最大サイズまで読み取る（巨大ページのメモリ肥大を防ぐ）。 */
async function readCappedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return await response.text();
  }
  const decoder = new TextDecoder();
  let result = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    result += decoder.decode(value, { stream: true });
    if (received >= MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }
  result += decoder.decode();
  return result;
}

/**
 * URL を解決して記事本文を抽出する。
 * t.co などの短縮 URL を渡してよい（リダイレクトを追って最終 URL に到達する）。
 */
export async function fetchArticle(inputUrl: string): Promise<FetchArticleResult> {
  const followed = await fetchFollowingRedirects(inputUrl);

  if ("xPostUrl" in followed) {
    return { final_url: followed.xPostUrl, title: "", text: "", status: "x_post" };
  }
  if ("xArticleUrl" in followed) {
    return { final_url: followed.xArticleUrl, title: "", text: "", status: "x_article", detail: "X ネイティブ記事は認証必須のため本文を取得できない" };
  }
  if ("failed" in followed) {
    return { final_url: inputUrl, title: "", text: "", status: "fetch_failed", detail: followed.failed };
  }

  const { finalUrl, response } = followed;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) {
    return { final_url: finalUrl, title: "", text: "", status: "not_article", detail: `content-type: ${contentType || "unknown"}` };
  }

  let html: string;
  try {
    html = await readCappedText(response);
  } catch {
    return { final_url: finalUrl, title: "", text: "", status: "fetch_failed", detail: "body read error" };
  }

  let article: ReturnType<Readability["parse"]>;
  try {
    const { document } = parseHTML(html);
    article = new Readability(document).parse();
  } catch {
    return { final_url: finalUrl, title: "", text: "", status: "not_article", detail: "parse error" };
  }

  const text = article?.textContent?.trim() ?? "";
  if (!article || text.length === 0) {
    return { final_url: finalUrl, title: article?.title ?? "", text: "", status: "not_article" };
  }

  return { final_url: finalUrl, title: article.title ?? "", text, status: "ok" };
}
