import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTargetApp } from "../../apps/target-app/server.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createTargetApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
});

const post = (p: string, body: unknown): Promise<Response> =>
  fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const form = (p: string, data: Record<string, string>): Promise<Response> =>
  fetch(base + p, {
    method: "POST",
    redirect: "follow",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data).toString(),
  });

beforeEach(async () => {
  await post("/_control/reset", {});
});

describe("target app shell", () => {
  it("serves a frameset with a named content frame", async () => {
    const html = await (await fetch(`${base}/teller`)).text();
    expect(html).toContain("<frameset");
    expect(html).toContain('name="content"');
  });

  it("has a labelled Member ID field and no test ids", async () => {
    const html = await (await fetch(`${base}/teller/search`)).text();
    expect(html).toMatch(/<label for="[^"]+">Member ID<\/label>/);
    expect(html).not.toContain("data-testid");
  });

  it("shifts incidental DOM structure between renders but keeps labels stable", async () => {
    const a = await (await fetch(`${base}/teller/search`)).text();
    const b = await (await fetch(`${base}/teller/search`)).text();
    expect(a).not.toBe(b);
    expect(b).toMatch(/<label for="[^"]+">Member ID<\/label>/);
  });
});

describe("member lookup", () => {
  it("finds a known member and lists them in the results table", async () => {
    const html = await (await form("/teller/search", { memberId: "100234" })).text();
    expect(html).toContain("Search Results");
    expect(html).toContain("Dana Whitfield");
  });

  it("shows the accounts table with a Savings balance on the detail screen", async () => {
    const html = await (await fetch(`${base}/teller/member/100234`)).text();
    expect(html).toContain("Current Balance");
    expect(html).toContain("$4,182.55");
    expect(html).toContain("Savings");
  });

  it("returns a not-found notice for an unknown member", async () => {
    const html = await (await form("/teller/search", { memberId: "999999" })).text();
    expect(html).toContain("No matching member");
  });

  it("returns a validation error for a malformed member id", async () => {
    const html = await (await form("/teller/search", { memberId: "12" })).text();
    expect(html).toContain("must be 6 digits");
  });
});

describe("injectable runtime faults", () => {
  it("shows the sign-on form once sessionExpired is armed, and clears on sign-on", async () => {
    await post("/_control/faults", { fault: "sessionExpired" });
    const html = await (await fetch(`${base}/teller/search`)).text();
    expect(html).toContain("Sign On");
    expect(html).toContain("Session Expired");

    const after = await (await form("/teller/signon", { username: "x", password: "y" })).text();
    expect(after).toContain("Member ID");
  });

  it("shows an interstitial that can be acknowledged, then proceeds", async () => {
    await post("/_control/faults", { fault: "interstitial" });
    expect(await (await fetch(`${base}/teller/search`)).text()).toContain("Acknowledge");
    await form("/teller/acknowledge", {});
    expect(await (await fetch(`${base}/teller/search`)).text()).toContain("Member ID");
  });

  it("denies permission when that fault is armed", async () => {
    await post("/_control/faults", { fault: "permissionDenied" });
    const html = await (await form("/teller/search", { memberId: "100234" })).text();
    expect(html).toContain("not authorized");
  });

  it("returns a 500 app error page when appError is armed", async () => {
    await post("/_control/faults", { fault: "appError" });
    const res = await fetch(`${base}/teller/search`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Unexpected system error");
  });

  it("forces a not-found result even for a real member when notFound is armed", async () => {
    await post("/_control/faults", { fault: "notFound" });
    const html = await (await form("/teller/search", { memberId: "100234" })).text();
    expect(html).toContain("No matching member");
  });

  it("delays the response when slowLoad is armed", async () => {
    await post("/_control/faults", { fault: "slowLoad" });
    const started = Date.now();
    await fetch(`${base}/teller/search`);
    expect(Date.now() - started).toBeGreaterThan(1500);
  });

  it("rejects an unknown fault name", async () => {
    expect((await post("/_control/faults", { fault: "wat" })).status).toBe(400);
  });
});
