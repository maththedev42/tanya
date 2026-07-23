// DeepSeek exposes the account's REAL balance at GET {base}/user/balance.
// Tanya's cost numbers are estimates (token counts × price table); the balance
// is the ground truth that catches estimate drift. Only DeepSeek bases serve
// the endpoint — anything else resolves null quickly and callers skip the line.

export interface DeepSeekBalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance?: string;
  toppedUpBalance?: string;
}

export interface DeepSeekBalance {
  available: boolean;
  balances: DeepSeekBalanceInfo[];
}

export async function fetchDeepSeekBalance(options: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<DeepSeekBalance | null> {
  const base = (options.baseUrl?.trim() || "https://api.deepseek.com").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_500);
  try {
    const response = await doFetch(`${base}/user/balance`, {
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = await response.json() as {
      is_available?: boolean;
      balance_infos?: Array<{
        currency?: string;
        total_balance?: string;
        granted_balance?: string;
        topped_up_balance?: string;
      }>;
    };
    const balances: DeepSeekBalanceInfo[] = (parsed.balance_infos ?? [])
      .filter((info) => typeof info.currency === "string" && typeof info.total_balance === "string")
      .map((info) => ({
        currency: info.currency as string,
        totalBalance: info.total_balance as string,
        ...(typeof info.granted_balance === "string" ? { grantedBalance: info.granted_balance } : {}),
        ...(typeof info.topped_up_balance === "string" ? { toppedUpBalance: info.topped_up_balance } : {}),
      }));
    return { available: parsed.is_available ?? balances.length > 0, balances };
  } catch {
    // Offline, timeout, or a non-DeepSeek base — the balance line is optional.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function formatBalanceLine(balance: DeepSeekBalance): string {
  if (balance.balances.length === 0) return "DeepSeek balance: unavailable";
  const parts = balance.balances.map((info) => {
    const detail = info.toppedUpBalance !== undefined || info.grantedBalance !== undefined
      ? ` (topped-up ${info.toppedUpBalance ?? "0"}, granted ${info.grantedBalance ?? "0"})`
      : "";
    return `${info.currency} ${info.totalBalance}${detail}`;
  });
  const warning = balance.available ? "" : " — account unavailable for API calls";
  return `DeepSeek balance: ${parts.join(" · ")}${warning}`;
}
