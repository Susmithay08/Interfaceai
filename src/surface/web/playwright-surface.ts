import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import type { ResolvedAction } from "../../model/action.js";
import type { EvidenceRef, EvidenceSink } from "../../model/evidence.js";
import type { Observation, ScopePath, UiNode } from "../../model/observation.js";
import { asRef, type Ref } from "../../model/ids.js";
import type { ControlLease } from "../../session/control-lease.js";
import { StaleRefError, type Surface } from "../surface.js";
import { collectNodes, type RawNode } from "./perceive.js";
import { HUMAN_ACTION_HOOK, instrumentationScript } from "./instrument.js";

/** See the note in observe(): keeps transpiler-injected helpers from breaking perception. */
const NAME_SHIM = "globalThis.__name = globalThis.__name || ((f) => f);";

interface Handle {
  readonly frame: Frame;
  readonly index: number;
  readonly observationId: string;
}

export interface LaunchOptions {
  readonly baseUrl: string;
  readonly headless: boolean;
  readonly lease: ControlLease;
  readonly evidence: EvidenceSink;
  readonly slowMoMs?: number;
}

export class PlaywrightWebSurface implements Surface {
  readonly kind = "web" as const;

  #handles = new Map<Ref, Handle>();
  #observationId = "";
  #instrumented = false;
  #counter = 0;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly lease: ControlLease,
    private readonly evidence: EvidenceSink,
  ) {}

  static async launch(opts: LaunchOptions): Promise<PlaywrightWebSurface> {
    const browser = await chromium.launch({
      headless: opts.headless,
      ...(opts.slowMoMs === undefined ? {} : { slowMo: opts.slowMoMs }),
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const surface = new PlaywrightWebSurface(browser, context, page, opts.lease, opts.evidence);

    // Human actions during an operator handoff report back through this binding.
    await context.exposeBinding(
      HUMAN_ACTION_HOOK,
      (_source, payload: unknown) => {
        const p = payload as {
          actionKind?: string;
          role?: string;
          accessibleName?: string;
          value?: string;
        };
        opts.evidence.event({
          type: "human_action",
          actor: "operator",
          actionKind: p.actionKind ?? "unknown",
          ...(p.role === undefined ? {} : { role: p.role }),
          ...(p.accessibleName === undefined ? {} : { accessibleName: p.accessibleName }),
          ...(p.value === undefined ? {} : { value: p.value }),
          at: new Date().toISOString(),
        });
      },
    );

    return surface;
  }

  /** Exposed so tests can prove the handoff uses the SAME context, never a fresh one. */
  contextId(): string {
    return String(this.context as unknown as object);
  }

  livePage(): Page {
    return this.page;
  }

  async observe(): Promise<Observation> {
    const observationId = `obs_${++this.#counter}`;
    this.#handles = new Map();
    this.#observationId = observationId;

    const nodes: UiNode[] = [];
    const frames = this.page.frames();

    for (let fi = 0; fi < frames.length; fi++) {
      const frame = frames[fi]!;
      let raw: RawNode[];
      try {
        // The transpiler (esbuild keepNames) can emit __name() wrappers inside the
        // serialized function. That helper does not exist in the page, so define a
        // no-op before evaluating. Without this, perception silently yields no nodes.
        await frame.evaluate(NAME_SHIM);
        raw = await frame.evaluate(collectNodes);
      } catch (err) {
        if (process.env["SURFACE_DEBUG"]) process.stderr.write(`perceive failed: ${String(err)}
`);
        continue; // frame detached mid-observation; the next observe() will see it
      }

      const scopeBase = this.#scopeOf(frame, fi);
      for (const n of raw) {
        // Observation id is part of the ref, so a ref from a previous
        // observation can never silently collide with a current one.
        const ref = asRef(`${observationId}f${fi}n${n.index}`);
        this.#handles.set(ref, { frame, index: n.index, observationId });

        const scope: ScopePath = n.region
          ? { path: scopeBase.path, region: { by: "heading", value: n.region } }
          : { path: scopeBase.path };

        nodes.push({
          ref,
          role: n.role,
          ...(n.name === undefined ? {} : { name: n.name }),
          ...(n.value === undefined ? {} : { value: n.value }),
          state: {
            visible: n.visible,
            ...(n.disabled === undefined ? {} : { disabled: n.disabled }),
            ...(n.required === undefined ? {} : { required: n.required }),
          },
          scope,
          anchors: n.anchors.map((a) => ({
            kind: a.kind as UiNode["anchors"][number]["kind"],
            text: a.text,
          })),
          ...(n.attrs === undefined ? {} : { attrs: n.attrs }),
        });
      }
    }

    const url = new URL(this.page.url());
    const observation: Observation = {
      observationId,
      surfaceKind: "web",
      locationHint: url.pathname + url.search,
      title: await this.page.title().catch(() => ""),
      screenSignature: signatureOf(nodes),
      nodes,
      capturedAt: new Date().toISOString(),
    };

    const ref = this.evidence.attach("observation", observationId, observation);
    this.evidence.event({
      type: "observation",
      observationId,
      screenSignature: observation.screenSignature,
      nodeCount: nodes.length,
      ...(observation.locationHint === undefined
        ? {}
        : { locationHint: observation.locationHint }),
      ref: ref.path,
      at: observation.capturedAt,
    });

    return observation;
  }

  async execute(action: ResolvedAction): Promise<void> {
    // Enforced on EVERY action: while the operator holds the session, automation cannot act.
    this.lease.assertHeldBy("automation");

    if (action.kind === "navigate") {
      await this.page.goto(action.url, { waitUntil: "domcontentloaded" });
      return;
    }

    if (action.kind === "pressKey" && action.ref === undefined) {
      await this.page.keyboard.press(action.key);
      return;
    }

    const ref = action.ref as Ref;
    const handle = this.#handles.get(ref);
    if (!handle || handle.observationId !== this.#observationId) {
      throw new StaleRefError(String(ref));
    }

    const locator = handle.frame.locator("*").nth(handle.index);

    switch (action.kind) {
      case "click":
      case "dismiss":
        await locator.click({ timeout: 5000 });
        break;
      case "fill":
        await locator.fill(action.value, { timeout: 5000 });
        break;
      case "select":
        await locator.selectOption(action.value, { timeout: 5000 });
        break;
      case "pressKey":
        await locator.press(action.key, { timeout: 5000 });
        break;
    }
  }

  async capture(reason: string): Promise<EvidenceRef> {
    const png = await this.page.screenshot({ fullPage: true });
    const safe = reason.replace(/[^a-z0-9-]+/gi, "-").slice(0, 40);
    return this.evidence.attach("screenshot", `${Date.now()}-${safe}`, png);
  }

  async instrument(on: boolean): Promise<void> {
    if (on === this.#instrumented) return;
    this.#instrumented = on;
    if (on) {
      await this.context.addInitScript(instrumentationScript);
      for (const frame of this.page.frames()) {
        await frame.evaluate(instrumentationScript).catch(() => undefined);
      }
    }
    // Turning instrumentation off simply stops new pages receiving the init script;
    // already-installed listeners are harmless once the operator hands control back.
  }

  async dispose(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }

  #scopeOf(frame: Frame, index: number): ScopePath {
    const name = frame.name();
    if (name) return { path: [{ by: "name", value: name }] };
    if (frame === this.page.mainFrame()) return { path: [{ by: "name", value: "main" }] };
    try {
      return { path: [{ by: "urlPath", value: new URL(frame.url()).pathname }] };
    } catch {
      return { path: [{ by: "index", value: index }] };
    }
  }
}

/** Structure only - roles and scopes, never values - so it is stable across members. */
function signatureOf(nodes: readonly UiNode[]): string {
  const shape = nodes
    .map((n) => `${n.role}|${n.scope.path.map((s) => `${s.by}:${s.value}`).join(">")}`)
    .join(";");
  return createHash("sha1").update(shape).digest("hex").slice(0, 16);
}
