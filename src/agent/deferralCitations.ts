// Deferral citations: an item deferred as "out of scope" must point at the
// prompt text that actually excludes it. The audited failure (FinanceWorld
// S1+T1) justified skipping a T2 requirement with a fabricated "Tier 3" scope
// quote that appears nowhere in the prompt — the report read as disciplined
// while inventing its own scope. This validator scans the final report BODY
// for deferral lines and nudges (never gates — an over-strict citation check
// must not false-FAIL a legitimately skipped item) when:
//   (a) a deferral line QUOTES scope text that does not exist in the prompt
//       (the fabricated-citation shape), or
//   (b) a line claims scope exclusion ("out of scope", "excluded by the
//       prompt", "Tier N"…) without quoting the prompt at all.
// Ordinary "skipped: <reason>" lines (no key available, env missing…) carry no
// scope claim and are left alone — those are honest operational skips.

const DEFERRAL_LINE = /\b(?:deferred?|defer|out of scope|not in scope|won'?t (?:do|implement|be done)|will not (?:do|implement)|excluded)\b/i;

const SCOPE_CLAIM = /\b(?:out of scope|not in scope|scope[- ]excluded|excluded (?:by|from|in|per) (?:the )?(?:prompt|task|spec|plan|tier)|per (?:the )?(?:prompt|task|spec|plan)|(?:prompt|task|spec|plan) (?:says|states|excludes|limits)|tier \d)\b/i;

// Quoted spans a deferral can cite: "…", '…', `…`, “…”. Minimum length keeps
// incidental quoted words ("done", 'skip') from being treated as citations.
const QUOTE_SPANS = /"([^"\n]{4,200})"|'([^'\n]{10,200})'|`([^`\n]{4,200})`|[“”]([^“”\n]{4,200})[“”]/g;

/** Collapse to lowercase alphanumeric words so punctuation/whitespace variance
 *  never defeats an honest citation. */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function quotedSpans(line: string): string[] {
  const spans: string[] = [];
  for (const match of line.matchAll(QUOTE_SPANS)) {
    const span = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (span && normalizeForMatch(span).length >= 4) spans.push(span);
  }
  return spans;
}

const MAX_NUDGES = 5;

/** Nudge lines for deferrals whose scope citation is missing or fabricated.
 *  Runs on the report BODY (before the deterministic footer is appended) so
 *  the coverage table's own "◌ skipped" rows are never scanned. */
export function deferralCitationNudges(reportBody: string, prompt: string): string[] {
  if (!prompt.trim() || !reportBody.trim()) return [];
  const normalizedPrompt = normalizeForMatch(prompt);
  const nudges: string[] = [];
  for (const rawLine of reportBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !DEFERRAL_LINE.test(line)) continue;
    const quotes = quotedSpans(line);
    if (quotes.length > 0) {
      for (const quote of quotes) {
        if (normalizedPrompt.includes(normalizeForMatch(quote))) continue;
        nudges.push(
          `unsupported deferral: the quoted scope text "${quote.slice(0, 120)}" is not found in the task prompt — cite the prompt literally or do the item.`,
        );
      }
    } else if (SCOPE_CLAIM.test(line)) {
      nudges.push(
        `unsupported deferral: "${line.slice(0, 120)}" claims a scope exclusion without quoting the prompt — cite the excluding prompt text literally.`,
      );
    }
    if (nudges.length >= MAX_NUDGES) break;
  }
  return [...new Set(nudges)].slice(0, MAX_NUDGES);
}
