import type { TweetV2, UserV2, MediaObjectV2 } from "twitter-api-v2";
import { loadCursor } from "../cursor.js";
import { fetchUserTweets, getOwnUser, toSafeError } from "../twitter-client.js";

export interface GetQuotedPostsInput {
  max_results?: number;
  since_id?: string;
  pagination_token?: string;
  limit?: number;
}

interface MediaOutput {
  url: string;
  type: string;
}

interface QuotedPostOutput {
  id: string;
  text: string;
  created_at: string;
  author_username: string;
  url: string;
  media: MediaOutput[];
}

interface PostOutput {
  id: string;
  text: string;
  created_at: string;
  url: string;
  quoted_post: QuotedPostOutput;
}

export interface GetQuotedPostsOutput {
  posts: PostOutput[];
  newest_seen_id: string | null;
  next_token: string | null;
  has_more: boolean;
}

// `limit`（古い順N件）モードで内部ページングするときのページサイズと、無限ループ防止のページ数上限。
// X の userTimeline 自体に遡及上限があるため、通常はこの上限に達する前に next_token が尽きる。
const INTERNAL_PAGE_SIZE = 100;
const MAX_INTERNAL_PAGES = 20;

type TweetMap = Map<string, TweetV2>;
type UserMap = Map<string, UserV2>;
type MediaMap = Map<string, MediaObjectV2>;

/** data 配列のうち引用ポストだけを、includes を引いて出力形に組み立てる。 */
function buildPosts(
  data: TweetV2[],
  includedTweets: TweetMap,
  includedUsers: UserMap,
  includedMedia: MediaMap,
  ownUsername: string,
): PostOutput[] {
  const posts: PostOutput[] = [];
  for (const tweet of data) {
    const quotedRef = tweet.referenced_tweets?.find((r) => r.type === "quoted");
    if (!quotedRef) {
      continue;
    }
    const quotedTweet = includedTweets.get(quotedRef.id);
    if (!quotedTweet) {
      continue;
    }
    const authorUsername = quotedTweet.author_id
      ? includedUsers.get(quotedTweet.author_id)?.username ?? ""
      : "";
    const mediaKeys = quotedTweet.attachments?.media_keys ?? [];
    const media: MediaOutput[] = mediaKeys
      .map((key) => includedMedia.get(key))
      .filter((m): m is MediaObjectV2 => m != null)
      .map((m) => ({ url: m.url ?? "", type: m.type }));

    posts.push({
      id: tweet.id,
      text: tweet.note_tweet?.text ?? tweet.text,
      created_at: tweet.created_at ?? "",
      url: `https://x.com/${ownUsername}/status/${tweet.id}`,
      quoted_post: {
        id: quotedTweet.id,
        text: quotedTweet.note_tweet?.text ?? quotedTweet.text,
        created_at: quotedTweet.created_at ?? "",
        author_username: authorUsername,
        url: `https://x.com/${authorUsername}/status/${quotedTweet.id}`,
        media,
      },
    });
  }
  return posts;
}

/** id（数字文字列）の昇順（古い→新しい）に並べ替える。Number では桁あふれするため BigInt で比較する。 */
function sortByIdAsc(posts: PostOutput[]): void {
  posts.sort((a, b) => {
    const ai = BigInt(a.id);
    const bi = BigInt(b.id);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

export async function getQuotedPosts(input: GetQuotedPostsInput): Promise<GetQuotedPostsOutput> {
  const sinceId = input.since_id ?? loadCursor();

  try {
    const { id: ownId, username: ownUsername } = await getOwnUser();

    // `limit` 指定時: MCP 側で全ページを繰り、古い順にソートして先頭 limit 件だけ返す。
    // 呼び出し側（Cowork タスク）は 36 件の全文をコンテキストに載せず、処理する古い N 件だけ受け取れる。
    if (input.limit != null) {
      const allData: TweetV2[] = [];
      const includedTweets: TweetMap = new Map();
      const includedUsers: UserMap = new Map();
      const includedMedia: MediaMap = new Map();
      let newestSeenId: string | null = null;
      let pageToken: string | undefined = undefined;

      for (let page = 0; page < MAX_INTERNAL_PAGES; page++) {
        const result = await fetchUserTweets(ownId, INTERNAL_PAGE_SIZE, sinceId, pageToken);
        // newest_seen_id はタイムライン全体の最大 id。最新ページ（1回目）の meta から取る。
        if (page === 0) {
          newestSeenId = result.meta?.newest_id ?? null;
        }
        for (const t of result.data ?? []) allData.push(t);
        for (const t of result.includes?.tweets ?? []) includedTweets.set(t.id, t);
        for (const u of result.includes?.users ?? []) includedUsers.set(u.id, u);
        for (const m of result.includes?.media ?? []) includedMedia.set(m.media_key, m);

        const nextToken = result.meta?.next_token;
        if (!nextToken) break;
        pageToken = nextToken;
      }

      const allPosts = buildPosts(allData, includedTweets, includedUsers, includedMedia, ownUsername);
      sortByIdAsc(allPosts);
      const limited = allPosts.slice(0, input.limit);
      const hasMore = allPosts.length > input.limit;

      return { posts: limited, newest_seen_id: newestSeenId, next_token: null, has_more: hasMore };
    }

    // 従来モード（後方互換）: 単一ページを返し、続きは呼び出し側が next_token でページ送りする。
    const maxResults = input.max_results ?? 20;
    const result = await fetchUserTweets(ownId, maxResults, sinceId, input.pagination_token);

    const data = result.data ?? [];
    const nextToken = result.meta?.next_token ?? null;
    if (data.length === 0) {
      return { posts: [], newest_seen_id: null, next_token: nextToken, has_more: nextToken != null };
    }

    const includedTweets: TweetMap = new Map((result.includes?.tweets ?? []).map((t) => [t.id, t]));
    const includedUsers: UserMap = new Map((result.includes?.users ?? []).map((u) => [u.id, u]));
    const includedMedia: MediaMap = new Map((result.includes?.media ?? []).map((m) => [m.media_key, m]));

    const posts = buildPosts(data, includedTweets, includedUsers, includedMedia, ownUsername);
    const newestSeenId = result.meta?.newest_id ?? null;

    return { posts, newest_seen_id: newestSeenId, next_token: nextToken, has_more: nextToken != null };
  } catch (error) {
    throw toSafeError(error);
  }
}
