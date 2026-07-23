import { resolve } from "node:path";
import { migrateLegacyDotDir } from "../init/migrateDotDir";
import { generateVideoAsset, videoPresets } from "../tools/videoTools";
import { renderFullAd } from "../tools/adRenderTools";
import { flagNumber, flagString, flagStrings, type ParsedArgs } from "./args";

export async function runVideoCommand(args: ParsedArgs): Promise<void> {
  const preset = args.positional[0] ?? "one-terminal-simctl";
  if (preset === "presets" || preset === "list") {
    console.log("Video presets:");
    for (const item of videoPresets) {
      const aliases = item.aliases.length ? ` aliases: ${item.aliases.join(", ")}` : "";
      console.log(`- ${item.name} (${item.width}x${item.height}, ${item.fps}fps, ${item.duration}s)${aliases}`);
      console.log(`  ${item.description}`);
    }
    return;
  }
  if (preset === "render-ad") {
    const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
    migrateLegacyDotDir(cwd);
    const input = flagString(args, "input");
    if (!input) {
      console.log("Usage: tanya video render-ad --input spec.json [--output-dir dir] [--basename name] [--format mp4] [--format poster]");
      return;
    }
    const formats = flagStrings(args, "format");
    const renderOptions: Parameters<typeof renderFullAd>[0] = {
      input,
      formats: formats.length ? formats as Array<"mp4" | "poster"> : ["mp4", "poster"],
    };
    const outputDir = flagString(args, "output-dir") ?? flagString(args, "outputDir");
    const basename = flagString(args, "basename");
    const ffmpegPath = flagString(args, "ffmpeg-path") ?? flagString(args, "ffmpegPath");
    if (outputDir) renderOptions.outputDir = outputDir;
    if (basename) renderOptions.basename = basename;
    if (ffmpegPath) renderOptions.ffmpegPath = ffmpegPath;
    const result = await renderFullAd(renderOptions, cwd);
    console.log(JSON.stringify({
      mp4Path: result.mp4Path,
      posterPath: result.posterPath,
      durationMs: result.durationMs,
      frameCount: result.frameCount,
      width: result.width,
      height: result.height,
      warnings: result.warnings,
    }, null, 2));
    return;
  }
  if (preset !== "one-terminal-simctl" && preset !== "terminal-simctl") {
    console.log("Usage: tanya video one-terminal-simctl [--output-dir dir] [--basename name] [--width 980] [--height 1012] [--duration 3] [--fps 30] [--format webm] [--format mov] [--format poster] [--line text]\n       tanya video render-ad --input spec.json [--output-dir dir] [--format mp4] [--format poster]");
    return;
  }
  const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
  migrateLegacyDotDir(cwd);
  const formats = flagStrings(args, "format");
  const options: Parameters<typeof generateVideoAsset>[0] = { preset };
  const outputDir = flagString(args, "output-dir") ?? flagString(args, "outputDir");
  const basename = flagString(args, "basename");
  const width = flagNumber(args, "width");
  const height = flagNumber(args, "height");
  const fps = flagNumber(args, "fps");
  const duration = flagNumber(args, "duration");
  const title = flagString(args, "title");
  const tab = flagString(args, "tab");
  const secondaryTab = flagString(args, "secondary-tab") ?? flagString(args, "secondaryTab");
  const badge = flagString(args, "badge");
  const lines = flagStrings(args, "line");
  if (outputDir) options.outputDir = outputDir;
  if (basename) options.basename = basename;
  if (width !== undefined) options.width = width;
  if (height !== undefined) options.height = height;
  if (fps !== undefined) options.fps = fps;
  if (duration !== undefined) options.duration = duration;
  if (formats.length > 0) options.formats = formats as Array<"webm" | "mov" | "poster">;
  if (title) options.title = title;
  if (tab) options.tab = tab;
  if (secondaryTab) options.secondaryTab = secondaryTab;
  if (badge) options.badge = badge;
  if (lines.length > 0) options.lines = lines;
  const result = await generateVideoAsset(options, cwd);
  console.log(`Generated ${result.files.length} video asset file${result.files.length === 1 ? "" : "s"}:`);
  for (const file of result.files) console.log(`- ${file}`);
}
