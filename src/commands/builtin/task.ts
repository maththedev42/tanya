import { readTaskMeta, taskDiff, taskDiscard, taskMerge } from "../../cli/worktree";
import { registerCommand } from "../registry";
import type { CommandDefinition } from "../registry";

const NOT_A_TASK =
  "This is not a task session. Start one with a worktree (the New Task action, or `tanya serve --stdio --worktree`).";

const taskDiffCommand: CommandDefinition = {
  name: "task-diff",
  description: "Show the diff of the current worktree task against its base.",
  category: "built-in",
  async handler(_args, ctx) {
    const meta = readTaskMeta(ctx.cwd);
    if (!meta) {
      ctx.output.write(`${NOT_A_TASK}\n`);
      return;
    }
    ctx.output.write(`${await taskDiff(meta)}\n`);
  },
};

const taskMergeCommand: CommandDefinition = {
  name: "task-merge",
  description: "Squash-merge the current worktree task into its origin branch, then remove the worktree.",
  category: "built-in",
  async handler(_args, ctx) {
    const meta = readTaskMeta(ctx.cwd);
    if (!meta) {
      ctx.output.write(`${NOT_A_TASK}\n`);
      return;
    }
    const result = await taskMerge(meta);
    ctx.output.write(`${result.ok ? result.message : result.reason}\n`);
  },
};

const taskDiscardCommand: CommandDefinition = {
  name: "task-discard",
  description: "Discard the current worktree task: delete its branch and remove the worktree.",
  category: "built-in",
  async handler(_args, ctx) {
    const meta = readTaskMeta(ctx.cwd);
    if (!meta) {
      ctx.output.write(`${NOT_A_TASK}\n`);
      return;
    }
    ctx.output.write(`${await taskDiscard(meta)}\n`);
  },
};

registerCommand(taskDiffCommand);
registerCommand(taskMergeCommand);
registerCommand(taskDiscardCommand);
