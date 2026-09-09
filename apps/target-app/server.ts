import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import { MEMBERS, MEMBER_ID_PATTERN, findMembers } from "./state.js";
import * as faults from "./faults.js";
import * as views from "./views.js";

const SLOW_LOAD_MS = 2500;

export function createTargetApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  /* ── fault control plane (test/demo only, not part of the modelled UI) ── */

  app.post("/_control/faults", (req: Request, res: Response) => {
    const fault: unknown = (req.body as { fault?: unknown }).fault;
    if (fault === null) {
      faults.reset();
      return res.json({ armed: null });
    }
    if (!faults.isFaultName(fault)) {
      return res.status(400).json({ error: "unknown fault" });
    }
    faults.arm(fault);
    return res.json({ armed: fault });
  });

  app.post("/_control/reset", (_req: Request, res: Response) => {
    faults.reset();
    res.json({ armed: null });
  });

  app.get("/_control/faults", (_req: Request, res: Response) => {
    res.json({ armed: faults.current() });
  });

  /* ── fault interception, ahead of every /teller route ── */

  const intercept = (req: Request, res: Response, next: NextFunction): void => {
    // Mounted at /teller, so req.path is already prefix-stripped.
    // The frameset shell itself is never intercepted: a real session timeout appears
    // INSIDE the content frame, leaving the shell in place. Intercepting the shell
    // would also destroy the frame scoping that targeting depends on.
    if (
      req.path === "/" ||
      req.path === "" ||
      req.path === "/signon" ||
      req.path === "/acknowledge"
    ) {
      next();
      return;
    }
    if (faults.isArmed("sessionExpired")) {
      res.status(200).send(views.signOn());
      return;
    }
    if (faults.isArmed("interstitial")) {
      res.status(200).send(views.interstitial());
      return;
    }
    if (faults.isArmed("appError")) {
      res.status(500).send(views.appError());
      return;
    }
    if (faults.isArmed("slowLoad")) {
      faults.clearOnce(); // transient by definition - the retry succeeds
      setTimeout(next, SLOW_LOAD_MS);
      return;
    }
    next();
  };

  app.use("/teller", intercept);

  /* ── the modelled application ── */

  app.get("/teller", (_req: Request, res: Response) => res.send(views.frameset()));
  app.get("/teller/", (_req: Request, res: Response) => res.send(views.frameset()));
  app.get("/teller/nav", (_req: Request, res: Response) => res.send(views.nav()));
  app.get("/teller/search", (_req: Request, res: Response) => res.send(views.searchForm()));

  app.post("/teller/signon", (_req: Request, res: Response) => {
    // Any synthetic credentials are accepted; this models re-authentication, not auth itself.
    faults.clearOnce();
    res.send(views.searchForm());
  });

  app.post("/teller/acknowledge", (_req: Request, res: Response) => {
    faults.clearOnce();
    res.send(views.searchForm());
  });

  app.post("/teller/search", (req: Request, res: Response) => {
    const memberId = String((req.body as { memberId?: unknown }).memberId ?? "").trim();

    if (faults.isArmed("permissionDenied")) {
      return res.status(200).send(views.permissionDenied());
    }
    if (faults.isArmed("validationError") || !MEMBER_ID_PATTERN.test(memberId)) {
      return res.status(200).send(views.searchForm("Member ID must be 6 digits."));
    }
    if (faults.isArmed("notFound")) {
      return res.status(200).send(views.searchResults([], "No matching member for that ID."));
    }

    const hits = findMembers(memberId);
    if (hits.length === 0) {
      return res.status(200).send(views.searchResults([], "No matching member for that ID."));
    }
    return res.status(200).send(views.searchResults(hits));
  });

  app.get("/teller/member/:id", (req: Request, res: Response) => {
    if (faults.isArmed("permissionDenied")) {
      return res.status(200).send(views.permissionDenied());
    }
    const member = MEMBERS[String(req.params["id"])];
    if (!member) {
      return res.status(200).send(views.searchResults([], "No matching member for that ID."));
    }
    return res.status(200).send(views.memberDetail(member));
  });

  app.get("/", (_req: Request, res: Response) => res.redirect("/teller"));

  return app;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isEntrypoint) {
  const port = Number(process.env["TARGET_APP_PORT"] ?? 4000);
  createTargetApp().listen(port, () => {
    process.stdout.write(`CoreBank Teller (synthetic data) listening on http://localhost:${port}\n`);
  });
}
