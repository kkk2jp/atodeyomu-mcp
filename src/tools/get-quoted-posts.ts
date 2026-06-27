import type { TweetV2 } from "twitter-api-v2";
import { loadCursor } from "../cursor.js";
import { fetchUserTweets, getOwnUser, toSafeError } from "../twitter-client.js";

export interface GetQuotedPostsInput {
  max_results?: number;
  since_id?: string;
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
}

export async function getQuotedPosts(input: GetQuotedPostsInput): Promise<GetQuotedPostsOutput> {
  const maxResults = input.max_results ?? 20;
  const sinceId = input.since_id ?? loadCursor();

  try {
    const { id: ownId, username: ownUsername } = await getOwnUser();
    const result = await fetchUserTweets(ownId, maxResults, sinceId);

    const data = result.data ?? [];
    if (data.length === 0) {
      return { posts: [], newest_seen_id: null };
    }

    const includedTweets = new Map((result.includes?.tweets ?? []).map((t) => [t.id, t]));
    const includedUsers = new Map((result.includes?.users ?? []).map((u) => [u.id, u]));
    const includedMedia = new Map((result.includes?.media ?? []).map((m) => [m.media_key, m]));

    const posts: PostOutput[] = [];
    for (const tweet of data) {
      const quotedRef = tweet.referenced_tweets?.find((r) => r.type === "quoted");
      if (!quotedRef) {
        continue;
      }
      const quotedTweet: TweetV2 | undefined = includedTweets.get(quotedRef.id);
      if (!quotedTweet) {
        continue;
      }
      const authorUsername = quotedTweet.author_id
        ? includedUsers.get(quotedTweet.author_id)?.username ?? ""
        : "";
      const mediaKeys = quotedTweet.attachments?.media_keys ?? [];
      const media: MediaOutput[] = mediaKeys
        .map((key) => includedMedia.get(key))
        .filter((m): m is NonNullable<typeof m> => m != null)
        .map((m) => ({ url: m.url ?? "", type: m.type }));

      posts.push({
        id: tweet.id,
        text: tweet.text,
        created_at: tweet.created_at ?? "",
        url: `https://x.com/${ownUsername}/status/${tweet.id}`,
        quoted_post: {
          id: quotedTweet.id,
          text: quotedTweet.text,
          created_at: quotedTweet.created_at ?? "",
          author_username: authorUsername,
          url: `https://x.com/${authorUsername}/status/${quotedTweet.id}`,
          media,
        },
      });
    }

    const newestSeenId = result.meta?.newest_id ?? null;

    return { posts, newest_seen_id: newestSeenId };
  } catch (error) {
    throw toSafeError(error);
  }
}
