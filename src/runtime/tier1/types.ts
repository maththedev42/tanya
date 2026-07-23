export type UICheck = {
  action: string;
  expected: string;
  actual: string;
  passed: boolean;
};

export type UIVerdict = {
  passed: boolean;
  appDescription: string;
  summary: string;
  checks: UICheck[];
  issues: string[];
};

// OpenAI-compatible chat-completions endpoint that drives the Tier-1 agent.
// Defaults to Tanya's own DeepSeek config — the agent reads the UI as TEXT
// (accessibility tree), so no vision model is required.
export type UiModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

// Platform-specific interaction driver injected into the agentic loop.
// Adapters produce one; tests inject a fake.
//
// Coordinate contract: tap(x, y) uses the SAME coordinate space as the UI
// tree returned by describeUi() — iOS accessibility frames are points (which
// idb taps natively), Android uiautomator bounds are pixels (which input tap
// uses natively). No conversion layer needed.
export type InteractDriver = {
  canTap: boolean;
  // Compact text description of every visible UI element with tap-ready
  // center coordinates. null when the host cannot produce a tree (e.g. iOS
  // without idb) — Tier-1 is skipped in that case.
  describeUi(): Promise<string | null>;
  // Evidence-only screenshot (never sent to the model).
  screenshot(path: string): Promise<boolean>;
  tap(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
};
