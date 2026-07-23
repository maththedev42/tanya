import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Run-archive discoverability.
//
// A run driven from a workspace ROOT (`tanya --cwd Appzinhos …`) writes its
// archive under the workspace's `.tanya/runs/`, while the repo it actually
// touched (e.g. `Appzinhos/tanya`) has its own `.tanya/runs/` holding OLDER
// runs. An auditor looks in the touched repo first, finds no fresh archive, and
// wrongly concludes "no archive". This drops a tiny pointer file
// `<runId>.at` in each touched repo's `.tanya/runs/` whose contents are the
// absolute path of the real archive — so the archive is one hop away from the
// repo, wherever the run was driven from.

/** The directory an archive pointer would live in for a given repo root. */
export function pointerDirForRepo(repoRoot: string): string {
  return join(repoRoot, ".tanya", "runs");
}

/**
 * Write `<runId>.at` pointer files into each touched repo's `.tanya/runs/`,
 * skipping any repo whose runs dir IS the archive dir (no self-pointer needed).
 * Best-effort: never throws — pointer writes must not fail a run.
 */
export function writeArchivePointers(
  archivePath: string,
  runId: string,
  touchedRepos: string[],
  archiveDir: string,
): void {
  for (const repoRoot of new Set(touchedRepos)) {
    try {
      const runsDir = pointerDirForRepo(repoRoot);
      // The archive already lives here (or in a parent-run subdir of here) —
      // nothing to point at.
      if (runsDir === archiveDir || runsDir === dirname(archiveDir)) continue;
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(join(runsDir, `${runId}.at`), `${archivePath}\n`, "utf8");
    } catch {
      // Per-repo pointer writes are best-effort.
    }
  }
}
