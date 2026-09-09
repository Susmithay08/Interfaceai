import express, { type Express, type Request, type Response } from "express";
import type { Server } from "node:http";
import type { InterventionRequest } from "../../src/model/escalation.js";
import type { EscalationService } from "../../src/session/escalation.js";
import type { OperatorHandoff } from "../../src/session/operator-handoff.js";

export interface ConsoleDeps {
  readonly escalation: EscalationService;
  readonly handoff: OperatorHandoff;
}

/**
 * The operator console runs IN the same process as the run it supervises, because the
 * whole point of the handoff is that it is the same live browser session. A console in a
 * separate process would have to start its own browser, and the operator would land on a
 * fresh login screen rather than the half-finished screen automation got stuck on.
 */
export function createOperatorConsole(deps: ConsoleDeps): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get("/api/interventions", (_req: Request, res: Response) => {
    res.json({ holder: deps.handoff.holder(), interventions: deps.escalation.list() });
  });

  app.get("/", (_req: Request, res: Response) => {
    res.send(page("Operator queue", queueBody(deps)));
  });

  app.get("/interventions/:id", (req: Request, res: Response) => {
    const iv = deps.escalation.get(req.params["id"]!);
    if (!iv) return res.status(404).send(page("Not found", "<p>No such intervention.</p>"));
    return res.send(page(iv.id, detailBody(iv, deps)));
  });

  app.post("/interventions/:id/take", (req: Request, res: Response) => {
    const id = req.params["id"]!;
    const iv = deps.escalation.get(id);
    if (!iv) return res.status(404).send("no such intervention");
    deps.escalation.markInProgress(id);
    return deps.handoff
      .take(`operator took control for ${id}`)
      .then(() => res.redirect(`/interventions/${id}`))
      .catch((e: unknown) => res.status(409).send(String(e)));
  });

  app.post("/interventions/:id/release", (req: Request, res: Response) => {
    const id = req.params["id"]!;
    const note = String(req.body?.note ?? "resolved by operator");
    return deps.handoff
      .release(`operator returned control for ${id}`)
      .then(() => {
        deps.escalation.resolve(id, note);
        res.redirect("/");
      })
      .catch((e: unknown) => res.status(409).send(String(e)));
  });

  return app;
}

/** Starts the console alongside a run. Returns a stop function for the run to call. */
export async function startOperatorConsole(
  deps: ConsoleDeps,
  port: number,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createOperatorConsole(deps).listen(port);
  await new Promise((r) => server.once("listening", r));
  return {
    url: `http://localhost:${port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/* ── rendering ────────────────────────────────────────────────────────── */

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const page = (title: string, body: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)} - Operator console</title>
<style>
 body{font:14px/1.5 system-ui,sans-serif;margin:2rem;max-width:60rem;color:#1a1a1a}
 h1{font-size:1.3rem} h2{font-size:1rem;margin-top:1.6rem}
 table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
 dt{font-weight:600;margin-top:.6rem} dd{margin:0}
 .who{padding:.3rem .6rem;background:#eef;border-radius:4px;display:inline-block}
 button{padding:.4rem .9rem;font:inherit;cursor:pointer}
 .empty{color:#666}
</style></head><body>${body}</body></html>`;

function queueBody(deps: ConsoleDeps): string {
  const open = deps.escalation.listOpen();
  const rows = open
    .map(
      (r) => `<tr><td><a href="/interventions/${esc(r.id)}">${esc(r.id)}</a></td>
        <td>${esc(r.mode)}</td><td>${esc(r.reason)}</td><td>${esc(r.stepId ?? "-")}</td>
        <td>${esc(r.status)}</td><td>${esc(r.createdAt)}</td></tr>`,
    )
    .join("");
  return `<h1>Operator queue</h1>
    <p>Session control: <span class="who">${esc(deps.handoff.holder())}</span></p>
    ${
      open.length === 0
        ? `<p class="empty">Nothing is waiting on a human.</p>`
        : `<table><tr><th>id</th><th>mode</th><th>reason</th><th>step</th><th>status</th><th>raised</th></tr>${rows}</table>`
    }`;
}

function detailBody(iv: InterventionRequest, deps: ConsoleDeps): string {
  const held = deps.handoff.holder() === "operator";
  const field = (label: string, value?: string): string =>
    value ? `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>` : "";

  return `<p><a href="/">&larr; queue</a></p>
    <h1>${esc(iv.id)} <small>(${esc(iv.status)})</small></h1>
    <dl>
      ${field("Goal", iv.goal)}
      ${field("Capability", iv.capabilityId)}
      ${field("Stopped at", iv.stepId ? `${iv.stepId} - ${iv.stepIntent ?? ""}` : undefined)}
      ${field("Why", iv.reason)}
      ${field("Expected", iv.expected)}
      ${field("Observed", iv.observed)}
      ${field("Screenshot", iv.screenshotRef)}
      ${field("Observation", iv.observationRef)}
      ${field("Resume", `${iv.resumePlan.mode} at ${iv.resumePlan.resumeAtStepId ?? "the start"}`)}
    </dl>
    <h2>Control</h2>
    <p>Session control: <span class="who">${esc(deps.handoff.holder())}</span></p>
    ${
      held
        ? `<form method="post" action="/interventions/${esc(iv.id)}/release">
             <p>Finish the step in the browser window, then hand control back.
                Everything you did was recorded into the run's evidence.</p>
             <input name="note" size="60" placeholder="what you did">
             <button type="submit">Release &amp; resume</button>
           </form>`
        : `<form method="post" action="/interventions/${esc(iv.id)}/take">
             <p>Taking control pauses automation on the same live page and starts
                recording your actions.</p>
             <button type="submit">Take control</button>
           </form>`
    }`;
}
