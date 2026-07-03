import { fetchArticle, type FetchArticleResult } from "../article.js";

export interface FetchArticleInput {
  url: string;
}

export type FetchArticleOutput = FetchArticleResult;

export async function getArticle(input: FetchArticleInput): Promise<FetchArticleOutput> {
  return await fetchArticle(input.url);
}
