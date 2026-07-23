// Kimi (Moonshot) exposes the account balance at GET {base}/users/me/balance.
// Tanya's cost numbers are estimates (token counts × price table); the balance
// is the ground truth that catches estimate drift. Best-effort: null on any
// error, timeout, or unexpected shape — the balance line is optional.

export interface KimiBalanceInfo {
  availableBalance: string;
  voucherBalance?: string;
  cashBalance?: string;
}

export interface KimiBalance {
  available: boolean;
  balances: KimiBalanceInfo[];
}

export async function fetchKimiBalance(options: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<KimiBalance | null> {
  const base = (options.baseUrl?.trim() || "https://api.moonshot.ai/v1").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_500);
  try {
    const response = await doFetch(`${base}/users/me/balance`, {
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = await response.json() as {
      code?: number;
      data?: {
        available_balance?: number;
        voucher_balance?: number;
        cash_balance?: number;
      };
      status?: number;
    };
    const data = parsed.data;
    if (!data || typeof data.available_balance !== "number") return null;
    const balances: KimiBalanceInfo[] = [{
      availableBalance: String(data.available_balance),
      ...(typeof data.voucher_balance === "number" ? { voucherBalance: String(data.voucher_balance) } : {}),
      ...(typeof data.cash_balance === "number" ? { cashBalance: String(data.cash_balance) } : {}),
    }];
    return { available: true, balances };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function formatKimiBalanceLine(balance: KimiBalance): string {
  if (balance.balances.length === 0) return "Kimi balance: unavailable";
  const parts = balance.balances.map((info) => {
    const detailParts: string[] = [];
    if (info.cashBalance !== undefined) detailParts.push(`cash ${info.cashBalance}`);
    if (info.voucherBalance !== undefined) detailParts.push(`voucher ${info.voucherBalance}`);
    const detail = detailParts.length > 0 ? ` (${detailParts.join(", ")})` : "";
    return `${info.availableBalance}${detail}`;
  });
  return `Kimi balance: ${parts.join(" · ")}`;
}
