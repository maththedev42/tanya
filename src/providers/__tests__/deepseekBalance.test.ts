import { describe, expect, it } from "vitest";
import { fetchDeepSeekBalance, formatBalanceLine } from "../deepseekBalance";

function fetchStub(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("fetchDeepSeekBalance", () => {
  it("parses the balance payload", async () => {
    const balance = await fetchDeepSeekBalance({
      apiKey: "sk-test",
      fetchImpl: fetchStub(200, {
        is_available: true,
        balance_infos: [
          { currency: "USD", total_balance: "12.34", granted_balance: "0.00", topped_up_balance: "12.34" },
        ],
      }),
    });

    expect(balance).toEqual({
      available: true,
      balances: [{ currency: "USD", totalBalance: "12.34", grantedBalance: "0.00", toppedUpBalance: "12.34" }],
    });
  });

  it("returns null on HTTP errors and network failures", async () => {
    await expect(fetchDeepSeekBalance({ apiKey: "sk-test", fetchImpl: fetchStub(401, {}) })).resolves.toBeNull();
    const throwing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(fetchDeepSeekBalance({ apiKey: "sk-test", fetchImpl: throwing })).resolves.toBeNull();
  });

  it("skips malformed balance entries", async () => {
    const balance = await fetchDeepSeekBalance({
      apiKey: "sk-test",
      fetchImpl: fetchStub(200, { balance_infos: [{ currency: "USD" }, { total_balance: "1.00" }] }),
    });
    expect(balance).toEqual({ available: false, balances: [] });
  });
});

describe("formatBalanceLine", () => {
  it("formats currency, total, and split", () => {
    expect(formatBalanceLine({
      available: true,
      balances: [{ currency: "USD", totalBalance: "12.34", grantedBalance: "0.00", toppedUpBalance: "12.34" }],
    })).toBe("DeepSeek balance: USD 12.34 (topped-up 12.34, granted 0.00)");
  });

  it("warns when the account cannot make API calls", () => {
    expect(formatBalanceLine({
      available: false,
      balances: [{ currency: "USD", totalBalance: "0.00" }],
    })).toBe("DeepSeek balance: USD 0.00 — account unavailable for API calls");
  });
});
