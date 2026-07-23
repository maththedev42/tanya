// Spec-coverage: parse a task prompt's explicit deliverable sections into a
// requirement manifest, then check the final report accounts for each one.
// Kills the "silently skipped a whole numbered Part / dropped columns and never
// mentioned it" failure: an unaccounted requirement forces the run incomplete
// and renders in a coverage table, so a silent drop is impossible.
//
// Deliberately conservative on extraction (only unambiguous heading markers —
// `## Part N`, `### G1`, `### TANYA-04`) and generous on "accounted for" (the id
// OR a majority of the title's words appearing anywhere in the report), so a
// genuinely-complete run is never false-failed. Compliance is easy because the
// system prompt tells the agent to name each Part/deliverable in its report;
// the gate merely enforces that, and a miss self-heals via one repair turn.

// `conditionalOn` marks a requirement whose own text gates it on ANOTHER
// prompt/step's deliverable ("if T3 has landed", "requires T2") — an id that
// is NOT one of this prompt's own sections. The audited failure reported PASS
// on such an item by implementing a slice of the OTHER prompt just to green
// the checkbox; prerequisite-conditional items therefore can never
// self-certify as done (see assessCoverage).
export type SpecRequirement = { id: string; title: string; conditionalOn?: string };
export type CoverageStatus = "done" | "skipped" | "pending";
// `evidence` is the report line that accounted for the item — captured for the
// run archive so an auditor sees WHERE each deliverable was addressed, not just
// that it was. Observational only; never affects `status`.
// `prerequisiteUnmet` records the prerequisite-honesty downgrade (done →
// skipped) so report.ts can surface the nudge without re-deriving it.
export type CoverageItem = { id: string; title: string; status: CoverageStatus; repeatOffense?: boolean; evidence?: string; prerequisiteUnmet?: boolean };

const HEADING_LINE = /^(#{2,4})\s+(.+?)\s*$/;
// A heading is a deliverable when it starts with `Part N` or an ID token like
// `G1`, `F2`, `TANYA-04`, `PUB-1`, `OPUS-01` (letters then a number).
const DELIVERABLE = /^(Part\s+\d+|[A-Za-z]{1,6}-?\d+)\b[\s:.—–-]*(.*)$/;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "into", "from", "your", "when",
  "each", "must", "also", "only", "over", "then", "than", "here", "them", "they",
  "kills", "adds", "plus", "step",
]);

function normalizeId(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

// A requirement is prerequisite-conditional when its section text gates it on
// a deliverable id — "if T3 has landed", "requires T2", "depends on OPUS-03",
// "after T1 lands". Only the first 400 chars of a section body are scanned so
// a stray mention deep in prose never marks the whole item conditional.
const PREREQ_REF = /\b(?:if|once|after|assuming|requires?|depends\s+on|blocked\s+(?:by|on))\s+(?:prompt\s+|task\s+|step\s+)?([A-Za-z]{1,6}-?\d{1,3})\b/i;
const PREREQ_BODY_SCAN_CHARS = 400;

function prerequisiteRef(text: string): string | null {
  const match = text.match(PREREQ_REF);
  return match?.[1] ? normalizeId(match[1]) : null;
}

/** Extract the prompt's deliverable sections (headings + a bounded body scan
 *  for cross-prompt prerequisite references). */
export function parseSpecRequirements(prompt: string): SpecRequirement[] {
  const out: SpecRequirement[] = [];
  const seen = new Set<string>();
  const bodies = new Map<string, string[]>();
  let currentKey: string | null = null;
  for (const rawLine of prompt.split(/\r?\n/)) {
    const heading = rawLine.match(HEADING_LINE);
    if (!heading) {
      if (currentKey) bodies.get(currentKey)?.push(rawLine);
      continue;
    }
    const headingText = (heading[2] ?? "").replace(/\*\*/g, "").trim();
    const deliverable = headingText.match(DELIVERABLE);
    if (!deliverable) {
      currentKey = null;
      continue;
    }
    const id = normalizeId(deliverable[1] ?? "");
    if (!id) {
      currentKey = null;
      continue;
    }
    const key = id.toLowerCase();
    if (seen.has(key)) {
      currentKey = null;
      continue;
    }
    seen.add(key);
    currentKey = key;
    bodies.set(key, []);
    const title = (deliverable[2] ?? "").replace(/[—–-]\s*$/, "").trim().slice(0, 120);
    out.push({ id, title });
  }
  // Conditional detection AFTER extraction so a reference to one of this
  // prompt's OWN sections ("after Part 1") reads as internal ordering, not a
  // cross-prompt prerequisite.
  const ownIds = new Set(out.map((req) => req.id.toLowerCase()));
  for (const req of out) {
    const body = (bodies.get(req.id.toLowerCase()) ?? []).join("\n").slice(0, PREREQ_BODY_SCAN_CHARS);
    const ref = prerequisiteRef(req.title) ?? prerequisiteRef(body);
    if (ref && !ownIds.has(ref.toLowerCase())) req.conditionalOn = ref;
  }
  return out;
}

function idVariants(id: string): string[] {
  const lower = id.toLowerCase();
  return [
    ...new Set([
      lower,
      lower.replace(/-/g, " "),
      lower.replace(/-/g, ""),
      lower.replace(/-0*(\d)/, "-$1"), // TANYA-04 → TANYA-4
      lower.replace(/\s+0*(\d)/, " $1"), // "part 04" → "part 4"
    ]),
  ];
}

function distinctiveTokens(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
    ),
  ];
}

const SKIP_WORDS = /\b(?:skip|skipped|defer|deferred|omit|omitted|out of scope|n\/a|not applicable|won'?t|will not)\b/i;

// Words that, on a report line mentioning the prerequisite id, evidence that
// the prerequisite genuinely exists in the repo (vs. the item merely being
// claimed done over a missing foundation).
const PREREQ_SATISFIED = /\b(?:landed|landing|exists?|present|already|done|completed?|merged|shipped|verified|implemented|in place|confirmed)\b/i;

function prerequisiteEvidenced(ref: string, lines: string[]): boolean {
  const variants = idVariants(ref);
  return lines.some((line) => {
    const ll = line.toLowerCase();
    return variants.some((v) => ll.includes(v)) && PREREQ_SATISFIED.test(line);
  });
}

/** For each requirement, decide done / skipped / pending from the report text.
 *  Prerequisite-conditional items (conditionalOn) can never self-certify as
 *  done: unless the report evidences the prerequisite as satisfied, a "done"
 *  claim is downgraded to "skipped" (honest, never a blocker — the downgrade
 *  is a nudge, so this can never false-FAIL a run; see the dodGate.ts
 *  contract). The audited failure reported PASS on a checklist item that
 *  depended on prompts that never ran. */
export function assessCoverage(requirements: SpecRequirement[], reportText: string): CoverageItem[] {
  const lower = reportText.toLowerCase();
  const lines = reportText.split(/\r?\n/);
  return requirements.map((req) => {
    const variants = idVariants(req.id);
    const idHit = variants.some((v) => lower.includes(v));
    const tokens = distinctiveTokens(req.title);
    const tokenHits = tokens.filter((t) => lower.includes(t)).length;
    const titleHit = tokens.length > 0 && tokenHits / tokens.length >= 0.6;
    if (!idHit && !titleHit) return { id: req.id, title: req.title, status: "pending" };
    const mentionLine = lines.find((line) => {
      const ll = line.toLowerCase();
      return variants.some((v) => ll.includes(v)) || tokens.some((t) => ll.includes(t));
    });
    let status: CoverageStatus = mentionLine && SKIP_WORDS.test(mentionLine) ? "skipped" : "done";
    let prerequisiteUnmet = false;
    if (status === "done" && req.conditionalOn && !prerequisiteEvidenced(req.conditionalOn, lines)) {
      status = "skipped";
      prerequisiteUnmet = true;
    }
    const evidence = prerequisiteUnmet
      ? `auto-skipped: prerequisite ${req.conditionalOn} not evidenced as satisfied`
      : mentionLine?.trim().slice(0, 200);
    return {
      id: req.id,
      title: req.title,
      status,
      ...(evidence ? { evidence } : {}),
      ...(prerequisiteUnmet ? { prerequisiteUnmet: true } : {}),
    };
  });
}

/** Render the coverage table for the final report. */
export function renderCoverageTable(items: CoverageItem[]): string {
  if (items.length === 0) return "";
  const mark = (s: CoverageStatus) => (s === "done" ? "✓ done" : s === "skipped" ? "◌ skipped" : "✗ PENDING");
  const rows = items.map((i) =>
    `- ${mark(i.status)} — ${i.id}${i.title ? `: ${i.title}` : ""}${i.repeatOffense ? " ⚠ repeat-offense (dropped in a recent prior run)" : ""}${i.prerequisiteUnmet ? " ⚠ prerequisite not evidenced — cannot self-certify as done" : ""}`);
  return ["Spec coverage:", ...rows].join("\n");
}
