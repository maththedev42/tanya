import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { TanyaTool, ToolContext, ToolResult } from "./types";

// Injectable so tests NEVER hit the live network. Production defaults to the
// global fetch; every test passes a stub.
export type FetchImpl = typeof globalThis.fetch;

export interface WebToolDeps {
  fetchImpl: FetchImpl;
  /** Resolve a hostname to IPs — injectable so SSRF tests stay offline. */
  resolveHost(host: string): Promise<string[]>;
}

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const SEARCH_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_TEXT_CHARS = 10_000;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;

function productionDeps(): WebToolDeps {
  return {
    fetchImpl: (...args: Parameters<FetchImpl>) => globalThis.fetch(...args),
    async resolveHost(host) {
      const records = await lookup(host, { all: true });
      return records.map((record) => record.address);
    },
  };
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

// RFC1918 + loopback + link-local + carrier-grade NAT + unique-local IPv6.
// Reject these to keep fetch_url from reaching cloud metadata or LAN services.
function isPrivateAddress(address: string): boolean {
  const host = address.toLowerCase();
  if (host === "::1" || host === "::") return true;
  if (host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd")) return true;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — check the embedded v4 tail.
  const mapped = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  if (isIP(mapped) !== 4) return isIP(host) === 4 ? isPrivateV4(host) : false;
  return isPrivateV4(mapped);
}

function isPrivateV4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a = -1, b = -1] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateHostname(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local");
}

async function guardUrl(raw: string, deps: WebToolDeps): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `Refusing non-http(s) scheme: ${url.protocol}` };
  }
  const host = url.hostname;
  if (isPrivateHostname(host)) {
    return { ok: false, error: `Refusing private host: ${host}` };
  }
  // A literal IP in the URL is checked directly; a hostname is resolved and
  // every returned address must be public (guards DNS-rebinding to LAN).
  if (isIP(host)) {
    if (isPrivateAddress(host)) return { ok: false, error: `Refusing private address: ${host}` };
  } else {
    let addresses: string[];
    try {
      addresses = await deps.resolveHost(host);
    } catch {
      return { ok: false, error: `Could not resolve host: ${host}` };
    }
    if (addresses.length === 0) return { ok: false, error: `Could not resolve host: ${host}` };
    if (addresses.some((address) => isPrivateAddress(address))) {
      return { ok: false, error: `Refusing host that resolves to a private address: ${host}` };
    }
  }
  return { ok: true, url };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// DuckDuckGo's HTML endpoint renders results as `<a class="result__a" …>` with
// the destination smuggled in a `uddg=` redirect param; the snippet lives in
// `result__snippet`. Parse defensively — a markup change degrades to "0
// results", never a crash.
interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function unwrapDuckUrl(href: string): string {
  try {
    const parsed = new URL(href, "https://duckduckgo.com");
    const target = parsed.searchParams.get("uddg");
    if (target) return target;
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : href;
  } catch {
    return href;
  }
}

export function parseDuckDuckGoHtml(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const anchor = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippet = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sMatch: RegExpExecArray | null;
  while ((sMatch = snippet.exec(html)) !== null) {
    snippets.push(stripHtml(sMatch[1] ?? ""));
  }
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = anchor.exec(html)) !== null && hits.length < limit) {
    const title = stripHtml(match[2] ?? "");
    const url = unwrapDuckUrl(decodeEntities(match[1] ?? ""));
    if (!title || !url) {
      index += 1;
      continue;
    }
    hits.push({ title, url, snippet: snippets[index] ?? "" });
    index += 1;
  }
  return hits;
}

// The lite endpoint (lite.duckduckgo.com/lite/) is a table of `result-link`
// anchors with `result-snippet` cells — simpler markup, often served when the
// heavier html endpoint rate-limits. Same defensive posture: unmatched markup
// degrades to 0 hits, never throws.
export function parseDuckDuckGoLite(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  // Lite markup is single-quoted with href BEFORE class (`<a rel="nofollow"
  // href="…" class='result-link'>`), so match the whole opening tag by the
  // result-link class in any attribute order/quote style, then pull href out.
  const anchor = /<a\b([^>]*\bresult-link\b[^>]*)>([\s\S]*?)<\/a>/gi;
  const snippet = /<td\b[^>]*\bresult-snippet\b[^>]*>([\s\S]*?)<\/td>/gi;
  const snippets: string[] = [];
  let sMatch: RegExpExecArray | null;
  while ((sMatch = snippet.exec(html)) !== null) {
    snippets.push(stripHtml(sMatch[1] ?? ""));
  }
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = anchor.exec(html)) !== null && hits.length < limit) {
    const hrefMatch = /href=['"]([^'"]+)['"]/i.exec(match[1] ?? "");
    const title = stripHtml(match[2] ?? "");
    const url = hrefMatch ? unwrapDuckUrl(decodeEntities(hrefMatch[1] ?? "")) : "";
    if (!title || !url) {
      index += 1;
      continue;
    }
    hits.push({ title, url, snippet: snippets[index] ?? "" });
    index += 1;
  }
  return hits;
}

// DuckDuckGo serves an anomaly/challenge page (often HTTP 200 or 202) instead
// of results when it rate-limits a client. Detect it so we fall through to the
// next engine rather than reporting a bogus "0 results".
export function looksBlocked(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  if (head.includes("anomaly") || head.includes("challenge-form") || head.includes("detected unusual")) return true;
  if (head.includes("if this error persists")) return true;
  return head.includes("blocked") && head.includes("traffic");
}

interface SearchEngine {
  name: string;
  url(query: string): string;
  parse(html: string, limit: number): SearchHit[];
}

// Tried in order; the first engine to return hits wins. The lite endpoint is a
// fallback for when the html endpoint blocks/rate-limits.
const SEARCH_ENGINES: SearchEngine[] = [
  {
    name: "duckduckgo-html",
    url: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    parse: parseDuckDuckGoHtml,
  },
  {
    name: "duckduckgo-lite",
    url: (query) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    parse: parseDuckDuckGoLite,
  },
];

function clampResults(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_RESULTS;
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(parsed)));
}

async function withTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function runWebSearch(input: unknown, deps: WebToolDeps): Promise<ToolResult> {
  const record = asRecord(input);
  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (!query) {
    return { ok: false, summary: "web_search needs a `query`.", error: "Missing string field: query" };
  }
  const limit = record.maxResults === undefined ? DEFAULT_RESULTS : clampResults(record.maxResults);

  const errors: string[] = [];
  let sawCleanEmpty = false;

  for (const [engineIndex, engine] of SEARCH_ENGINES.entries()) {
    let html: string;
    try {
      html = await withTimeout(SEARCH_TIMEOUT_MS, async (signal) => {
        const response = await deps.fetchImpl(engine.url(query), {
          signal,
          headers: { "User-Agent": DESKTOP_UA, Accept: "text/html" },
        });
        // 202 is DuckDuckGo's rate-limit tell; treat it as a retryable block.
        if (response.status === 202) throw new Error("rate-limited (HTTP 202)");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      });
    } catch (error) {
      errors.push(`${engine.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (looksBlocked(html)) {
      errors.push(`${engine.name}: rate-limited/blocked`);
      continue;
    }

    const hits = engine.parse(html, limit);
    if (hits.length === 0) {
      // Clean fetch, genuinely no matches — record it and try the next engine
      // in case this one soft-blocked; if all come back empty it's a real 0.
      sawCleanEmpty = true;
      continue;
    }

    const output = hits
      .map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ""}`)
      .join("\n\n");
    // Note the fallback engine so the caller (and the model) know why results
    // may look different from a normal run.
    const via = engineIndex === 0 ? "" : ` (via ${engine.name})`;
    return { ok: true, summary: `${hits.length} result(s) for "${query}"${via}.`, output };
  }

  if (sawCleanEmpty) {
    return { ok: true, summary: `0 results for "${query}".`, output: "No results found." };
  }
  return {
    ok: false,
    summary: `web_search failed for "${query}".`,
    error: errors.join("; ") || "all search engines failed",
  };
}

// Decide how to render a fetched body from its Content-Type. HTML is stripped
// to readable text; JSON/plain/xml/js pass through verbatim so structured data
// stays intact; binary is refused rather than dumped as mojibake.
export function classifyContent(contentType: string): "html" | "text" | "binary" {
  const ct = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (!ct) return "html";
  if (ct.startsWith("image/") || ct.startsWith("video/") || ct.startsWith("audio/") || ct.startsWith("font/")) return "binary";
  if (ct === "application/pdf" || ct === "application/zip" || ct === "application/gzip" || ct === "application/octet-stream") return "binary";
  if (ct === "text/html" || ct === "application/xhtml+xml") return "html";
  if (ct === "application/json" || ct.endsWith("+json")) return "text";
  if (ct === "application/xml" || ct.endsWith("+xml")) return "text";
  if (ct === "application/javascript" || ct === "application/x-javascript" || ct === "application/ecmascript") return "text";
  if (ct.startsWith("text/")) return "text";
  return "html";
}

export async function runFetchUrl(input: unknown, deps: WebToolDeps): Promise<ToolResult> {
  const record = asRecord(input);
  const raw = typeof record.url === "string" ? record.url.trim() : "";
  if (!raw) {
    return { ok: false, summary: "fetch_url needs a `url`.", error: "Missing string field: url" };
  }

  let current = raw;
  let body = "";
  let finalUrl = raw;
  let contentType = "";
  try {
    body = await withTimeout(FETCH_TIMEOUT_MS, async (signal) => {
      // Follow redirects manually so each hop is re-checked against the SSRF
      // guard (a public URL can 302 to a private one).
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const guard = await guardUrl(current, deps);
        if (!guard.ok) throw new Error(guard.error);
        finalUrl = guard.url.toString();
        const response = await deps.fetchImpl(finalUrl, {
          signal,
          redirect: "manual",
          headers: { "User-Agent": DESKTOP_UA, Accept: "text/html,application/json,text/plain,*/*" },
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new Error(`Redirect with no location (HTTP ${response.status})`);
          current = new URL(location, finalUrl).toString();
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        contentType = response.headers.get("content-type") ?? "";
        return await response.text();
      }
      throw new Error(`Too many redirects (> ${MAX_REDIRECTS})`);
    });
  } catch (error) {
    return {
      ok: false,
      summary: `fetch_url failed for ${raw}.`,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const kind = classifyContent(contentType);
  if (kind === "binary") {
    const ct = (contentType.split(";")[0] ?? "").trim() || "unknown";
    return {
      ok: false,
      summary: `fetch_url: ${finalUrl} is binary content (${ct}), not readable as text.`,
      error: `non-text content: ${ct}`,
    };
  }

  // HTML → strip markup to readable text. JSON/plain/xml/js → pass through
  // verbatim (only normalizing newlines/trailing space) so structured data
  // reaches the model intact instead of being mangled by tag-stripping.
  const rendered = kind === "html" ? stripHtml(body) : body.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  const truncated = rendered.length > MAX_TEXT_CHARS;
  const output = truncated
    ? `${rendered.slice(0, MAX_TEXT_CHARS)}\n… [truncated at ${MAX_TEXT_CHARS.toLocaleString("en-US")} chars]`
    : rendered;
  const ctLabel = (contentType.split(";")[0] ?? "").trim() || "text/html";
  return {
    ok: true,
    summary: `Fetched ${finalUrl} (${ctLabel}, ${rendered.length.toLocaleString("en-US")} chars${truncated ? ", truncated" : ""}).`,
    output: output || "(empty response body)",
  };
}

export const webSearchTool: TanyaTool = {
  name: "web_search",
  description:
    "Search the web (DuckDuckGo, no API key) and get a numbered list of {title, url, snippet}. Use to find docs, error messages, or current information. Read-only; degrades to an error you can work around if the network is unavailable.",
  truncateLargeResults: true,
  definition: {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web and return titles, URLs, and snippets. Read-only, no API key.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          maxResults: { type: "number", description: "How many results (1–10, default 5)." },
        },
        required: ["query"],
      },
    },
  },
  run(input: unknown, _context: ToolContext): Promise<ToolResult> {
    return runWebSearch(input, productionDeps());
  },
};

export const fetchUrlTool: TanyaTool = {
  name: "fetch_url",
  description:
    "Fetch a public URL and return its content: HTML pages come back as readable text (scripts/styles/markup stripped); JSON, plain text, and XML pass through verbatim; binary (images, PDFs) is refused. http(s) only; refuses private/loopback hosts. Use after web_search to read a result, to read a docs page, or to hit a public JSON API.",
  truncateLargeResults: true,
  definition: {
    type: "function",
    function: {
      name: "fetch_url",
      description: "GET a public URL and return its readable text. Read-only; blocks private/loopback hosts.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "An http(s) URL to fetch." },
        },
        required: ["url"],
      },
    },
  },
  run(input: unknown, _context: ToolContext): Promise<ToolResult> {
    return runFetchUrl(input, productionDeps());
  },
};
