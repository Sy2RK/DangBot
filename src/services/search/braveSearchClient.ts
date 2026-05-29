import type { AppConfig } from '../../types.js';

export interface WebSearchResult {
  kind: 'web' | 'news';
  title: string;
  url: string;
  description?: string;
  age?: string;
  extraSnippets: string[];
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
}

export interface WebSearchClient {
  configured(): boolean;
  search(query: string, signal?: AbortSignal): Promise<WebSearchResponse>;
}

interface BraveSearchResponse {
  query?: {
    original?: string;
    altered?: string;
  };
  web?: {
    results?: BraveResult[];
  };
  news?: {
    results?: BraveResult[];
  };
  error?:
    | {
        message?: string;
      }
    | string;
}

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  extra_snippets?: string[];
}

export class BraveSearchClient implements WebSearchClient {
  constructor(private readonly config: AppConfig['search']) {}

  configured(): boolean {
    return (
      this.config.enabled &&
      this.config.provider === 'brave' &&
      this.config.braveApiKey.trim().length > 0
    );
  }

  async search(query: string, signal?: AbortSignal): Promise<WebSearchResponse> {
    if (!this.configured()) {
      throw new Error('联网搜索尚未配置。请设置 search.enabled 和 Brave Search API key。');
    }

    const normalizedQuery = normalizeQuery(query);
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', normalizedQuery);
    url.searchParams.set('count', String(this.config.count));
    url.searchParams.set('safesearch', this.config.safeSearch);
    url.searchParams.set('spellcheck', 'true');
    url.searchParams.set('extra_snippets', this.config.extraSnippets ? 'true' : 'false');

    if (this.config.country) url.searchParams.set('country', this.config.country);
    if (this.config.searchLang) url.searchParams.set('search_lang', this.config.searchLang);
    if (this.config.uiLang) url.searchParams.set('ui_lang', this.config.uiLang);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.config.braveApiKey
        },
        signal
      });
    } catch (error) {
      throw new Error(`Brave 搜索网络请求失败：${describeNetworkError(error)}`);
    }

    const text = await response.text();
    const data = parseJson<BraveSearchResponse>(text);
    if (!response.ok) {
      throw new Error(`Brave 搜索失败：HTTP ${response.status} ${readBraveError(data)}`);
    }

    return {
      query: data.query?.altered ?? data.query?.original ?? normalizedQuery,
      results: [
        ...normalizeResults('web', data.web?.results ?? []),
        ...normalizeResults('news', data.news?.results ?? [])
      ].slice(0, this.config.count)
    };
  }
}

export function formatWebSearchResultsForLlm(response: WebSearchResponse): string {
  if (response.results.length === 0) return '没有搜索结果。';

  return response.results
    .map((result, index) => {
      const snippets = [result.description, ...result.extraSnippets.slice(0, 2)].filter(Boolean);
      return [
        `[${index + 1}] ${result.title}`,
        `类型：${result.kind}`,
        `URL：${result.url}`,
        result.age ? `时间：${result.age}` : undefined,
        snippets.length > 0 ? `摘要：${snippets.join(' / ')}` : undefined
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

export function formatWebSearchSources(response: WebSearchResponse): string {
  if (response.results.length === 0) return '';
  return response.results
    .map((result, index) => `来源 ${index + 1}：${result.title} ${result.url}`)
    .join('\n');
}

function normalizeQuery(query: string): string {
  const trimmed = query.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('搜索关键词不能为空。');
  return trimmed.length > 400 ? trimmed.slice(0, 400) : trimmed;
}

function normalizeResults(kind: 'web' | 'news', results: BraveResult[]): WebSearchResult[] {
  return results
    .map((result) => ({
      kind,
      title: normalizeField(result.title) || normalizeField(result.url) || 'Untitled',
      url: normalizeField(result.url),
      description: normalizeField(result.description),
      age: normalizeField(result.age),
      extraSnippets: (result.extra_snippets ?? []).map(normalizeField).filter(Boolean)
    }))
    .filter((result) => Boolean(result.url));
}

function normalizeField(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function parseJson<T>(text: string): T {
  try {
    return text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

function readBraveError(data: BraveSearchResponse): string {
  if (typeof data.error === 'string') return data.error;
  return data.error?.message ?? '';
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return error.message;
  }
  return String(error);
}
