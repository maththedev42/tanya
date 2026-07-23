import { describe, expect, it } from "vitest";
import { fetchKimiBalance, formatKimiBalanceLine } from "../kimiBalance";

function fetchStub(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("fetchKimiBalance", () => {
  it("parses the balance payload", async () => {
    const balance = await fetchKimiBalance({
      apiKey: "sk-test",
      fetchImpl: fetchStub(200, {
        code: 0,
        data: { available_balance: 12.34, voucher_balance: 1.0, cash_balance: 11.34 },
        status: 200,
      }),
    });

    expect(balance).toEqual({
      available: true,
      balances: [{ availableBalance: "12.34", voucherBalance: "1", cashBalance: "11.34" }],
    });
  });

  it("tolerates a payload with only available_balance", async () => {
    const balance = await fetchKimiBalance({
      apiKey: "sk-test",
      fetchImpl: fetchStub(200, { data: { available_balance: 5 } }),
    });
    expect(balance).toEqual({ available: true, balances: [{ availableBalance: "5" }] });
  });

  it("returns null on HTTP errors and network failures", async () => {
    await expect(fetchKimiBalance({ apiKey: "sk-test", fetchImpl: fetchStub(401, {}) })).resolves.toBeNull();
    const throwing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(fetchKimiBalance({ apiKey: "sk-test", fetchImpl: throwing })).resolves.toBeNull();
  });

  it("returns null when available_balance is missing or non-numeric", async () => {
    await expect(fetchKimiBalance({ apiKey: "sk-test", fetchImpl: fetchStub(200, { data: {} }) })).resolves.toBeNull();
    await expect(fetchKimiBalance({ apiKey: "sk-test", fetchImpl: fetchStub(200, { data: { available_balance: "12" } }) })).resolves.toBeNull();
    await expect(fetchKimiBalance({ apiKey: "sk-test", fetchImpl: fetchStub(200, {}) })).resolves.toBeNull();
  });
});

describe("formatKimiBalanceLine", () => {
  it("formats the available balance with cash/voucher detail", () => {
    expect(formatKimiBalanceLine({
      available: true,
      balances: [{ availableBalance: "12.34", voucherBalance: "1", cashBalance: "11.34" }],
    })).toBe("Kimi balance: 12.34 (cash 11.34, voucher 1)");
  });

  it("formats a bare available balance without detail parens", () => {
    expect(formatKimiBalanceLine({
      available: true,
      balances: [{ availableBalance: "5" }],
    })).toBe("Kimi balance: 5");
  });
});
