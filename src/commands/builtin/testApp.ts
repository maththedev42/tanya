import { captureGitSnapshot } from "../../agent/git";
import { RuntimeUsageError, runBootTest } from "../../runtime";
import { bootVerdictToManifest, buildBootReportText } from "../../runtime/manifest";
import { resolveUiModelConfig } from "../../runtime/uiModel";
import { registerCommand } from "../registry";
import type { CommandDefinition } from "../registry";

const testAppCommand: CommandDefinition = {
  name: "test-app",
  description:
    "Boot the built app and watch it run (Tier-0), optionally UI-test it (--tier1). Usage: /test-app [platform] [--tier1] [--record]",
  category: "built-in",
  async handler(args, ctx) {
    const tier1 = args.includes("--tier1");
    const record = args.includes("--record");
    const platform = args.find((arg) => !arg.startsWith("--"));
    const uiModel = tier1 ? resolveUiModelConfig() : undefined;
    if (tier1 && !uiModel) {
      ctx.output.write("[runtime] --tier1 needs a model key (DEEPSEEK_API_KEY / TANYA_API_KEY / TANYA_UI_API_KEY) — skipping UI test\n");
    }
    try {
      const verdict = await runBootTest({
        workspace: ctx.cwd,
        ...(platform ? { platform } : {}),
        tier1,
        record,
        ...(uiModel !== undefined ? { uiModel } : {}),
        emit: (message) => {
          ctx.output.write(`[runtime] ${message}\n`);
        },
      });
      const git = await captureGitSnapshot(ctx.cwd);
      const report = buildBootReportText(verdict, bootVerdictToManifest(verdict, git));
      ctx.output.write(`${report.trim()}\n`);
    } catch (err) {
      if (err instanceof RuntimeUsageError) {
        ctx.output.write(`${err.message}\n`);
        return;
      }
      throw err;
    }
  },
};

registerCommand(testAppCommand);
