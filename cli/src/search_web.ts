import { htmlToReadableText } from "./core/html_text.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

let announcedSearchDestination = false;

/** Reset destination announcement (used in tests). */
export function resetSearchWebAnnouncements(): void {
  announcedSearchDestination = false;
}

/**
 * Perform technical web search (Candidate #45, REQ-PRV-108).
 * Supports SearXNG (via SEARXNG_URL/SEARX_URL) and DuckDuckGo JSON & HTML endpoints.
 * Never fabricates search results when none are returned. Discloses destination on first use.
 */
export async function executeWebSearch(
  query: string,
  maxResults: number = 5
): Promise<{ success: boolean; results: SearchResult[]; error?: string }> {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return { success: false, results: [], error: "Empty query provided." };
  }

  // Disclosure gate: allow policy to disable outbound search
  if (process.env.NEXUS_DISABLE_WEB_SEARCH === "1") {
    return { success: false, results: [], error: "Web search is disabled by policy (NEXUS_DISABLE_WEB_SEARCH=1)." };
  }

  // 1. Try SearXNG if configured
  const searxUrl = process.env.SEARXNG_URL || process.env.SEARX_URL;

  // Disclose default or configured search destination on first use in this process
  if (!announcedSearchDestination) {
    announcedSearchDestination = true;
    const dest = searxUrl ? `${searxUrl} (SearXNG)` : "https://duckduckgo.com (DuckDuckGo)";
    console.error(`[nexus] Web search: sending query to ${dest} (default search provider; configure SEARXNG_URL for self-hosted search).`);
  }

  if (searxUrl) {
    try {
      const target = `${searxUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(cleanQuery)}&format=json`;
      const res = await fetch(target, {
        headers: { "User-Agent": "NexusCode/1.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
        if (data.results && Array.isArray(data.results)) {
          const results = data.results.slice(0, maxResults).map((r) => ({
            title: r.title || "Untitled",
            url: r.url || "",
            snippet: r.content || "",
          }));
          if (results.length > 0) {
            return { success: true, results };
          }
          return { success: false, results: [], error: "No web results found." };
        }
      }
    } catch {
      // Fall through to fallback
    }
  }

  // 2. DuckDuckGo Instant Answer API fallback
  try {
    const ddgApi = `https://api.duckduckgo.com/?q=${encodeURIComponent(cleanQuery)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(ddgApi, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NexusCode/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        Heading?: string;
        AbstractText?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };

      const results: SearchResult[] = [];
      if (data.AbstractText && data.AbstractURL) {
        results.push({
          title: data.Heading || cleanQuery,
          url: data.AbstractURL,
          snippet: data.AbstractText,
        });
      }

      if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
        for (const topic of data.RelatedTopics) {
          if (results.length >= maxResults) break;
          if (topic.Text && topic.FirstURL) {
            results.push({
              title: topic.Text.slice(0, 60),
              url: topic.FirstURL,
              snippet: topic.Text,
            });
          }
        }
      }

      if (results.length > 0) {
        return { success: true, results };
      }
    }
  } catch {
    // Fall through to HTML scraping fallback
  }

  // 3. DuckDuckGo HTML Lite scraping fallback
  try {
    const ddgHtml = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;
    const res = await fetch(ddgHtml, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const html = await res.text();
      const results: SearchResult[] = [];
      const resultBlocks = html.split('<div class="result results_links');

      for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
        const block = resultBlocks[i];
        const titleMatch = block.match(/<a[^>]+class="result__url"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
          block.match(/<a[^>]+class="result__snippet"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);

        if (titleMatch) {
          const rawUrl = titleMatch[1];
          let url = rawUrl;
          const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
          if (uddgMatch) {
            try {
              url = decodeURIComponent(uddgMatch[1]);
            } catch {}
          }

          const stripHtml = (s: string) => htmlToReadableText(s);
          const title = stripHtml(titleMatch[2] || "Result");
          const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";

          results.push({ title, url, snippet });
        }
      }

      if (results.length > 0) {
        return { success: true, results };
      }
    }
  } catch (err: any) {
    return {
      success: false,
      results: [],
      error: `Web search failed: ${err.message}`,
    };
  }

  return {
    success: false,
    results: [],
    error: "No web results found.",
  };
}
