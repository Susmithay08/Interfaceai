import { describe, it, expect } from "vitest";
import { ControlLease } from "../../../src/session/control-lease.js";
import { ControlNotHeldError } from "../../../src/model/escalation.js";

describe("ControlLease", () => {
  it("starts unheld and grants to automation", () => {
    const lease = new ControlLease();
    expect(lease.holder()).toBe("none");
    lease.acquire("automation");
    expect(lease.holder()).toBe("automation");
  });

  it("assertHeldBy throws ControlNotHeld for the wrong holder", () => {
    const lease = new ControlLease();
    lease.acquire("automation");
    expect(() => lease.assertHeldBy("operator")).toThrow(ControlNotHeldError);
    expect(() => lease.assertHeldBy("automation")).not.toThrow();
  });

  it("rejects a transfer from a holder that does not hold it", () => {
    const lease = new ControlLease();
    lease.acquire("automation");
    expect(() => lease.transfer("operator", "automation", "bogus")).toThrow(/holds the session/);
  });

  it("emits a change event on every transfer", () => {
    const lease = new ControlLease();
    const seen: string[] = [];
    lease.onChange((e) => seen.push(`${e.from}->${e.to}`));
    lease.acquire("automation");
    lease.transfer("automation", "operator", "escalation");
    lease.transfer("operator", "automation", "handback");
    expect(seen).toEqual(["none->automation", "automation->operator", "operator->automation"]);
  });

  it("records a history of transfers for the evidence log", () => {
    const lease = new ControlLease();
    lease.acquire("automation");
    lease.transfer("automation", "operator", "escalation");
    expect(lease.history()).toHaveLength(2);
    expect(lease.history()[1]!.reason).toBe("escalation");
  });

  it("waitUntilHeldBy resolves immediately when already held", async () => {
    const lease = new ControlLease();
    lease.acquire("automation");
    await expect(lease.waitUntilHeldBy("automation", 50)).resolves.toBeUndefined();
  });

  it("waitUntilHeldBy resolves when control returns", async () => {
    const lease = new ControlLease();
    lease.acquire("automation");
    lease.transfer("automation", "operator", "escalation");
    const waiting = lease.waitUntilHeldBy("automation", 2000);
    setTimeout(() => lease.transfer("operator", "automation", "handback"), 20);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("waitUntilHeldBy rejects on timeout", async () => {
    const lease = new ControlLease();
    lease.acquire("automation");
    lease.transfer("automation", "operator", "escalation");
    await expect(lease.waitUntilHeldBy("automation", 60)).rejects.toThrow(/timed out/);
  });
});
