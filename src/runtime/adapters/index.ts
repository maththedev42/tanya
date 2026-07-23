import type { BootAdapter } from "../types";
import { androidAdapter } from "./android";
import { backendAdapter } from "./backend";
import { iosAdapter } from "./ios";
import { macosAdapter } from "./macos";
import { scriptAdapter } from "./script";
import { webAdapter } from "./web";

// All Tier-0 platforms. The orchestrator looks adapters up by platform;
// detection lives in ../detect.ts, not on the adapter.
export const builtinAdapters: BootAdapter[] = [
  backendAdapter,
  webAdapter,
  scriptAdapter,
  androidAdapter,
  iosAdapter,
  macosAdapter,
];
