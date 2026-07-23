import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Live tool smoke: drives the REAL CLI (dist/cli.js) with the real configured
// provider through a task that forces the core tools, then verifies every
// outcome on disk and in git — model prose is never trusted. This spends
// provider credits, so it is NOT part of `npm test`; run it on demand:
//
//   npm run smoke:tools-live
//
// It catches the integration failures unit tests cannot: provider rejecting a
// tool schema, argument parsing drift, permission-engine regressions, and
// tools misbehaving under the real agent loop.

const repoRoot = resolve(import.meta.dirname ?? ".", "..");
const cli = join(repoRoot, "dist", "cli.js");
if (!existsSync(cli)) {
  console.error("dist/cli.js not found — run `npm run build` first.");
  process.exit(2);
}

const workspace = mkdtempSync(join(tmpdir(), "tanya-live-smoke-"));
const git = (args: string[]) =>
  spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
git(["init", "-q"]);
// Real projects gitignore Tanya's runtime dir; without this the agent's own
// .tanya/ artifacts would fail the tree-clean check below.
writeFileSync(join(workspace, ".gitignore"), ".tanya/\n");
git(["add", ".gitignore"]);
git(["commit", "-q", "-m", "init"]);

const prompt = [
  "Tool exercise task on plain text files. Follow these steps EXACTLY, in order, and use the NAMED tool for each step (do not substitute run_shell for steps 1-4):",
  "1. write_file: create notes/source.txt with exactly these three lines: alpha, beta, gamma (one word per line).",
  "2. copy_file: copy notes/source.txt to notes/copy.txt.",
  "3. search_replace: in notes/copy.txt replace the line \"beta\" with \"delta\".",
  "4. read_file: re-read notes/copy.txt and confirm it now contains delta.",
  "5. run_shell: run `wc -l < notes/source.txt` and then use write_file to store the trimmed number into notes/wc.txt.",
  "6. Commit the three notes/ files with the exact commit message: tool-smoke: exercise complete",
  "STRICT LIMITS: create ONLY the three files under notes/. Do NOT create package.json, index.js, scripts, or any other file. This is NOT an app project — do NOT run `tanya test-app` or any runtime tester.",
  "Verification: run_shell `grep -q delta notes/copy.txt && test -f notes/wc.txt && echo TOOLSMOKE_OK`.",
].join("\n");

console.log(`workspace: ${workspace}`);
console.log("running live agent (this spends provider credits)...");
const started = Date.now();
const run = spawnSync(process.execPath, [cli, "run", prompt, "--max-turns", "60"], {
  cwd: workspace,
  encoding: "utf8",
  timeout: 15 * 60 * 1000,
  env: process.env,
});
const elapsed = ((Date.now() - started) / 1000).toFixed(0);
console.log(`agent finished in ${elapsed}s with exit code ${run.status}`);

const failures: string[] = [];
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
}

const readOrEmpty = (path: string) => {
  try {
    return readFileSync(join(workspace, path), "utf8");
  } catch {
    return "";
  }
};

check("agent exit code 0", run.status === 0);
const source = readOrEmpty("notes/source.txt");
check("write_file: notes/source.txt has alpha/beta/gamma lines", ["alpha", "beta", "gamma"].every((word) => source.split(/\r?\n/).includes(word)));
const copy = readOrEmpty("notes/copy.txt");
check("copy_file + search_replace: notes/copy.txt has delta, not beta", copy.includes("delta") && !copy.split(/\r?\n/).includes("beta"));
check("run_shell + write_file: notes/wc.txt is a number", /^\d+$/.test(readOrEmpty("notes/wc.txt").trim()));
const lastMessage = git(["log", "-1", "--format=%s"]).stdout.trim();
check("commit: last message is the requested one", lastMessage.includes("tool-smoke"));
check("commit: working tree clean", git(["status", "--porcelain"]).stdout.trim() === "");

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed. Last agent output:`);
  console.error((run.stdout ?? "").split("\n").slice(-40).join("\n"));
  console.error(run.stderr ?? "");
  console.error(`workspace kept for inspection: ${workspace}`);
  process.exit(1);
}

rmSync(workspace, { recursive: true, force: true });
console.log("\nAll live tool checks passed.");
