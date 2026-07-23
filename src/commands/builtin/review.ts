import { execFileSync } from "node:child_process";
import { reviewChanges } from "../../agent/reviewer";
import { registerCommand } from "../registry";
import type { CommandContext, CommandDefinition } from "../registry";

// The reviewer feeds this to the model. Keep it well under the context budget
// while still covering realistic turns; the reviewer adds its own second slice.
const MAX_DIFF_CHARS = 60_000;

function git(cwd: string, args: string[]): string {
  // stdin/stderr ignored so git's "not a repository" chatter never leaks to the
  // serve process' stderr; stdout is captured for the diff.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

// `/review` looks at the working tree; `--staged` at the index. Untracked files
// never show in `git diff`, so surface them by name so the reviewer knows new
// files exist even though it can't see their contents in the diff.
function collectDiff(cwd: string, staged: boolean): string {
  if (staged) return git(cwd, ["diff", "--cached"]);

  const tracked = git(cwd, ["diff", "HEAD"]);
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]).trim();
  if (!untracked) return tracked;
  const list = untracked
    .split("\n")
    .map((file) => `# new (untracked): ${file}`)
    .join("\n");
  return `${tracked}\n${list}\n`;
}

const reviewCommand: CommandDefinition = {
  name: "review",
  description: "Review the working-tree diff (or --staged) with the code reviewer.",
  category: "built-in",
  async handler(args: string[], ctx: CommandContext) {
    const staged = args.includes("--staged");

    let diff: string;
    try {
      diff = collectDiff(ctx.cwd, staged);
    } catch {
      ctx.output.write("/review needs a git repository with at least one commit to diff against.\n");
      return;
    }

    if (!diff.trim()) {
      ctx.output.write("Nothing to review.\n");
      return;
    }

    const provider = ctx.provider;
    if (!provider) {
      ctx.output.write("/review has no provider configured for this session.\n");
      return;
    }

    let truncated = false;
    if (diff.length > MAX_DIFF_CHARS) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated at ${MAX_DIFF_CHARS.toLocaleString("en-US")} chars]`;
      truncated = true;
    }

    ctx.output.write(staged ? "Reviewing staged changes…\n\n" : "Reviewing working-tree changes…\n\n");
    if (truncated) {
      ctx.output.write(`(diff was larger than ${MAX_DIFF_CHARS.toLocaleString("en-US")} chars — reviewing the first part only)\n\n`);
    }

    const task = staged ? "Review the staged changes." : "Review the current working-tree changes.";
    const review = await reviewChanges(provider, task, diff, { maxDiffChars: MAX_DIFF_CHARS });
    ctx.output.write(`${review}\n`);
  },
};

registerCommand(reviewCommand);
