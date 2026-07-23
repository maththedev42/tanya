import { describe, expect, it } from "vitest";
import { looksBlocked, parseDuckDuckGoHtml, parseDuckDuckGoLite, runFetchUrl, runWebSearch, type WebToolDeps } from "../webTools";

function makeResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

// A fetch stub that returns canned responses per call. Tests NEVER touch the
// live network; the resolver defaults to a public address.
function deps(overrides: Partial<WebToolDeps> = {}): WebToolDeps {
  return {
    fetchImpl: (async () => makeResponse("")) as unknown as WebToolDeps["fetchImpl"],
    resolveHost: async () => ["93.184.216.34"], // example.com, public
    ...overrides,
  };
}

const DDG_HTML = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fdocs&rut=abc">Node.js Docs</a>
  <a class="result__snippet" href="#">The official <b>Node.js</b> documentation.</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">Example Guide</a>
  <a class="result__snippet" href="#">A short &amp; sweet guide.</a>
</div>
`;

describe("parseDuckDuckGoHtml", () => {
  it("unwraps uddg redirect URLs, decodes entities, and pairs snippets", () => {
    const hits = parseDuckDuckGoHtml(DDG_HTML, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: "Node.js Docs",
      url: "https://nodejs.org/docs",
      snippet: "The official Node.js documentation.",
    });
    expect(hits[1]?.url).toBe("https://example.com/guide");
    expect(hits[1]?.snippet).toBe("A short & sweet guide.");
  });

  it("honors the result limit", () => {
    expect(parseDuckDuckGoHtml(DDG_HTML, 1)).toHaveLength(1);
  });
});

describe("runWebSearch", () => {
  it("returns a numbered result list from the stubbed endpoint", async () => {
    let requestedUrl = "";
    const result = await runWebSearch({ query: "node docs", maxResults: 2 }, deps({
      fetchImpl: (async (url: string) => {
        requestedUrl = url;
        return makeResponse(DDG_HTML);
      }) as unknown as WebToolDeps["fetchImpl"],
    }));

    expect(requestedUrl).toContain("html.duckduckgo.com");
    expect(requestedUrl).toContain("q=node%20docs");
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("2 result(s)");
    expect(String(result.output)).toContain("1. Node.js Docs");
    expect(String(result.output)).toContain("https://nodejs.org/docs");
  });

  it("requires a query", async () => {
    const result = await runWebSearch({}, deps());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("query");
  });

  it("fails cleanly (ok:false) on an HTTP error", async () => {
    const result = await runWebSearch({ query: "x" }, deps({
      fetchImpl: (async () => makeResponse("nope", { status: 503 })) as unknown as WebToolDeps["fetchImpl"],
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("503");
  });

  it("returns 0 results (still ok) when parsing finds nothing", async () => {
    const result = await runWebSearch({ query: "x" }, deps({
      fetchImpl: (async () => makeResponse("<html>no results</html>")) as unknown as WebToolDeps["fetchImpl"],
    }));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("0 results");
  });
});

// Mirrors real lite.duckduckgo.com markup: single-quoted class, href BEFORE
// class, a rel attribute, uddg-wrapped hrefs.
const LITE_HTML = `
<table>
  <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa&rut=x" class='result-link'>Result A</a></td></tr>
  <tr><td class='result-snippet'>Snippet A here.</td></tr>
  <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb" class='result-link'>Result B</a></td></tr>
  <tr><td class='result-snippet'>Snippet B &amp; more.</td></tr>
</table>`;

const ANOMALY_HTML = `<html><body><form class="anomaly-modal__form">Please verify — we detected unusual traffic.</form></body></html>`;

// Dispatch a stubbed response by which endpoint was requested — lets tests
// exercise the html-then-lite fallback without any network.
function byUrl(map: { html?: () => Response; lite?: () => Response }): WebToolDeps["fetchImpl"] {
  return (async (url: string) => {
    if (url.includes("lite.duckduckgo.com")) {
      if (!map.lite) throw new Error("unexpected lite call");
      return map.lite();
    }
    if (!map.html) throw new Error("unexpected html call");
    return map.html();
  }) as unknown as WebToolDeps["fetchImpl"];
}

describe("parseDuckDuckGoLite", () => {
  it("parses the lite table's result-link anchors and snippets", () => {
    const hits = parseDuckDuckGoLite(LITE_HTML, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ title: "Result A", url: "https://example.org/a", snippet: "Snippet A here." });
    expect(hits[1]?.url).toBe("https://example.org/b");
    expect(hits[1]?.snippet).toBe("Snippet B & more.");
  });
});

describe("looksBlocked", () => {
  it("flags anomaly/challenge pages and passes normal result pages", () => {
    expect(looksBlocked(ANOMALY_HTML)).toBe(true);
    expect(looksBlocked(DDG_HTML)).toBe(false);
  });
});

describe("runWebSearch engine fallback", () => {
  it("falls back to the lite endpoint when the html endpoint is rate-limited (HTTP 202)", async () => {
    const result = await runWebSearch({ query: "q" }, deps({
      fetchImpl: byUrl({
        html: () => makeResponse("", { status: 202 }),
        lite: () => makeResponse(LITE_HTML),
      }),
    }));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("via duckduckgo-lite");
    expect(String(result.output)).toContain("Result A");
  });

  it("falls back when the html endpoint returns an anomaly/challenge page", async () => {
    const result = await runWebSearch({ query: "q" }, deps({
      fetchImpl: byUrl({
        html: () => makeResponse(ANOMALY_HTML),
        lite: () => makeResponse(LITE_HTML),
      }),
    }));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("via duckduckgo-lite");
  });

  it("uses the html endpoint without a fallback note when it works", async () => {
    const result = await runWebSearch({ query: "q" }, deps({
      fetchImpl: byUrl({ html: () => makeResponse(DDG_HTML) }),
    }));
    expect(result.ok).toBe(true);
    expect(result.summary).not.toContain("via");
  });

  it("fails cleanly when BOTH engines error", async () => {
    const result = await runWebSearch({ query: "q" }, deps({
      fetchImpl: byUrl({
        html: () => makeResponse("", { status: 503 }),
        lite: () => makeResponse("", { status: 500 }),
      }),
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("duckduckgo-html: HTTP 503");
    expect(result.error).toContain("duckduckgo-lite: HTTP 500");
  });
});

describe("runFetchUrl SSRF guard", () => {
  it("refuses non-http(s) schemes", async () => {
    const result = await runFetchUrl({ url: "file:///etc/passwd" }, deps());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("non-http(s)");
  });

  it("refuses localhost", async () => {
    const result = await runFetchUrl({ url: "http://localhost:8080/admin" }, deps());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("private host");
  });

  it("refuses a literal private IP without any network call", async () => {
    let called = false;
    const result = await runFetchUrl({ url: "http://169.254.169.254/latest/meta-data/" }, deps({
      fetchImpl: (async () => { called = true; return makeResponse(""); }) as unknown as WebToolDeps["fetchImpl"],
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("private address");
    expect(called).toBe(false);
  });

  it("refuses a hostname that resolves to a private address (DNS rebinding)", async () => {
    const result = await runFetchUrl({ url: "http://sneaky.example/" }, deps({
      resolveHost: async () => ["10.0.0.5"],
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("private address");
  });

  it("re-checks redirect targets against the guard", async () => {
    const result = await runFetchUrl({ url: "https://public.example/start" }, deps({
      fetchImpl: (async () => makeResponse("", {
        status: 302,
        headers: { location: "http://127.0.0.1/secret" },
      })) as unknown as WebToolDeps["fetchImpl"],
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("private");
  });
});

describe("runFetchUrl content handling", () => {
  it("strips scripts/styles/tags and collapses whitespace", async () => {
    const html = `<html><head><style>.x{color:red}</style><script>alert(1)</script></head>
      <body>  <h1>Hello</h1>   <p>World &amp; friends</p> </body></html>`;
    const result = await runFetchUrl({ url: "https://example.com/page" }, deps({
      fetchImpl: (async () => makeResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as WebToolDeps["fetchImpl"],
    }));
    expect(result.ok).toBe(true);
    const text = String(result.output);
    expect(text).toContain("Hello");
    expect(text).toContain("World & friends");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("color:red");
  });

  it("truncates long pages with a note", async () => {
    const big = `<p>${"A".repeat(20_000)}</p>`;
    const result = await runFetchUrl({ url: "https://example.com/big" }, deps({
      fetchImpl: (async () => makeResponse(big, { headers: { "content-type": "text/html" } })) as unknown as WebToolDeps["fetchImpl"],
    }));
    expect(result.ok).toBe(true);
    expect(String(result.output)).toContain("truncated at 10,000 chars");
    expect(result.summary).toContain("truncated");
  });

  it("passes JSON through verbatim instead of stripping it as HTML", async () => {
    const json = '{"version":"1.2.3","tags":["<b>not html</b>"]}';
    const result = await runFetchUrl({ url: "https://api.example.com/v1" }, deps({
      fetchImpl: (async () => makeResponse(json, { headers: { "content-type": "application/json" } })) as unknown as WebToolDeps["fetchImpl"],
    }));
    expect(result.ok).toBe(true);
    expect(result.output).toBe(json); // untouched — angle brackets and all
    expect(result.summary).toContain("application/json");
  });

  it("passes plain text through verbatim", async () => {
    const txt = "line 1\nline 2 <keep this>\n";
    const result = await runFetchUrl({ url: "https://example.com/robots.txt" }, deps({
      fetchImpl: (async () => makeResponse(txt, { headers: { "content-type": "text/plain" } })) as unknown as WebToolDeps["fetchImpl"],
    }));
    expect(result.ok).toBe(true);
    expect(String(result.output)).toContain("<keep this>");
  });

  it("refuses binary content instead of dumping mojibake", async () => {
    const result = await runFetchUrl({ url: "https://example.com/logo.png" }, deps({
      fetchImpl: (async () => makeResponse("\x89PNG\r\n", { headers: { "content-type": "image/png" } })) as unknown as WebToolDeps["fetchImpl"],
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("non-text content");
    expect(result.summary).toContain("image/png");
  });

  it("maps an aborted/failed fetch to a clean ok:false (no throw, no hang)", async () => {
    // Simulate the timeout firing: fetch rejects with an AbortError immediately
    // instead of us waiting the real 10s window.
    const result = await runFetchUrl({ url: "https://example.com/slow" }, deps({
      fetchImpl: (async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      }) as unknown as WebToolDeps["fetchImpl"],
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("aborted");
  });
});
