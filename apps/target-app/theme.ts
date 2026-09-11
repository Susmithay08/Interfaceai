/**
 * The skin, and ONLY the skin.
 *
 * This app is a stand-in for a legacy core-banking screen, and its hostility is
 * load-bearing: framesets, table layout, no test ids, meaningless class names,
 * wrapper depth that shifts between renders. None of that changes here. What a real
 * institution does to an app like this is re-skin it - new chrome over 1997 bones -
 * and that is exactly what this file does.
 *
 * The rule that makes it safe: NOTHING here adds, removes or renames an element.
 *
 *   - The backdrop lives on `html::before` and the wordmark on `body::before`.
 *     Pseudo-elements are absent from `document.querySelectorAll("*")` and contribute
 *     nothing to `textContent`, so perception cannot see them - no new nodes, no
 *     shifted anchors, no altered `value` on any ancestor.
 *   - No rule uses `display:none` or `visibility:hidden`. `perceive.ts` reads those to
 *     decide `visible`, and an invisible node is dropped before targeting, so hiding
 *     anything here would silently change what the resolver can find.
 *   - No class name introduced anywhere contains `errmsg` or `notice`. `roleOf` keys
 *     the `alert` and `status` roles off those substrings; a decorative class matching
 *     either would mint a phantom node and could make a target ambiguous.
 *
 * Design: frosted panels over a guilloché field - the rosette line-work engraved on
 * banknotes and share certificates. Blur needs high-frequency detail to look like
 * frost rather than a grey box, and the subject supplies its own. One brass accent,
 * from the vault-and-ledger end of the same vernacular. Radii stay small: the surface
 * is modern, the geometry stays administrative. System fonts only, so it renders the
 * same offline as on a machine that has never seen a font CDN.
 */

const TOKENS = `
  --vault-900: #04181A;
  --vault-800: #06201F;
  --vault-700: #0A2E2B;
  --vault-600: #12403A;

  --brass:     #C9A227;
  --brass-lit: #E3C158;
  --alarm:     #E0525E;

  --ink:       #EAF2EE;
  --ink-dim:   rgba(234, 242, 238, 0.66);
  --ink-faint: rgba(234, 242, 238, 0.40);

  --pane:      rgba(234, 242, 238, 0.10);
  --pane-lit:  rgba(234, 242, 238, 0.17);
  --edge:      rgba(234, 242, 238, 0.20);
  --edge-lit:  rgba(255, 255, 255, 0.38);

  --frost:     blur(26px) saturate(150%);
  --radius:    5px;
`;

/**
 * Layered rosettes and hairlines. Two repeating-radial-gradients at different periods
 * beat against each other the way real lathework does, and the 24deg hairlines give the
 * blur something to chew on. Fixed, so both frames sit on one continuous field.
 */
const FIELD = `
  radial-gradient(1100px 760px at 12% -12%, rgba(18, 64, 58, 0.62), transparent 62%),
  radial-gradient(880px 640px at 108% 18%, rgba(201, 162, 39, 0.11), transparent 58%),
  repeating-radial-gradient(circle at 22% 28%, rgba(234,242,238,.045) 0 1px, transparent 1px 7px),
  repeating-radial-gradient(circle at 79% 74%, rgba(234,242,238,.038) 0 1px, transparent 1px 9px),
  repeating-linear-gradient(24deg, rgba(234,242,238,.03) 0 1px, transparent 1px 6px),
  linear-gradient(158deg, #06201F 0%, #0A2E2B 52%, #04181A 100%)
`;

export const THEME = `<style>
:root {${TOKENS}}

html { box-sizing: border-box; }
*, *::before, *::after { box-sizing: inherit; }

html::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  background: ${FIELD};
}

body {
  margin: 0;
  padding: 22px 24px 30px;
  min-height: 100vh;
  background: transparent;
  color: var(--ink);
  font: 14px/1.55 ui-sans-serif, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}

/* ── the page shell: body > table > tr > td.tdl is the frosted card ──────── */

/* Capped, so the panel reads as a deliberate sheet of glass rather than a bar
   stretched to whatever the window happens to be. */
body > table { width: 100%; max-width: 860px; border-collapse: separate; }

body > table > tbody > tr > td.tdl {
  padding: 24px 26px 28px;
  background: linear-gradient(157deg, var(--pane-lit), var(--pane) 62%);
  -webkit-backdrop-filter: var(--frost);
  backdrop-filter: var(--frost);
  border: 1px solid var(--edge);
  border-radius: var(--radius);
  box-shadow:
    0 24px 54px rgba(0, 0, 0, 0.42),
    inset 0 1px 0 var(--edge-lit),
    inset 0 -1px 0 rgba(4, 24, 26, 0.30);
}

/* ── headings ───────────────────────────────────────────────────────────── */

h2 {
  margin: 30px 0 14px;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.012em;
  color: var(--ink);
}

body > table > tbody > tr > td.tdl > h2:first-child { margin-top: 0; }

h3 {
  margin: 2px 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-dim);
}

hr {
  margin: 18px 0;
  border: 0;
  border-top: 1px solid var(--edge);
}

/* ── data grids: the border="1" tables carry the real content ────────────── */

table[border="1"] {
  border-collapse: collapse;
  margin-top: 4px;
  background: rgba(4, 24, 26, 0.34);
  border: 1px solid var(--edge);
  border-radius: var(--radius);
  overflow: hidden;
}

table[border="1"] th {
  padding: 9px 14px;
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: var(--brass-lit);
  background: rgba(4, 24, 26, 0.5);
  border-bottom: 1px solid var(--edge);
  white-space: nowrap;
}

table[border="1"] td {
  padding: 9px 14px;
  border-bottom: 1px solid rgba(234, 242, 238, 0.07);
  color: var(--ink);
}

table[border="1"] tr:last-child td { border-bottom: 0; }
table[border="1"] tr:hover td { background: rgba(234, 242, 238, 0.045); }

/* ── layout tables stay invisible scaffolding ────────────────────────────── */

table[border="0"] { border-collapse: collapse; }

td.tdl {
  padding: 5px 14px 5px 0;
  color: var(--ink-dim);
  white-space: nowrap;
}

td.c3 { padding: 5px 0; }

/* ── form controls ──────────────────────────────────────────────────────── */

label { color: var(--ink-dim); }

input[type="text"], input[type="password"] {
  padding: 8px 11px;
  min-width: 190px;
  color: var(--ink);
  font: inherit;
  font-variant-numeric: tabular-nums;
  background: rgba(4, 24, 26, 0.45);
  border: 1px solid var(--edge);
  border-radius: 4px;
  outline: none;
}

input[type="text"]:focus, input[type="password"]:focus {
  border-color: var(--brass);
  box-shadow: 0 0 0 3px rgba(201, 162, 39, 0.22);
}

input[type="submit"] {
  margin-top: 10px;
  padding: 8px 20px;
  color: var(--vault-900);
  font: inherit;
  font-weight: 600;
  background: linear-gradient(180deg, var(--brass-lit), var(--brass));
  border: 1px solid rgba(201, 162, 39, 0.85);
  border-radius: 4px;
  cursor: pointer;
  box-shadow: 0 6px 16px rgba(201, 162, 39, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.36);
}

input[type="submit"]:hover { filter: brightness(1.07); }
input[type="submit"]:active { transform: translateY(1px); }

:focus-visible { outline: 2px solid var(--brass-lit); outline-offset: 2px; }

/* ── links ──────────────────────────────────────────────────────────────── */

a {
  color: var(--brass-lit);
  text-decoration: none;
  border-bottom: 1px solid rgba(227, 193, 88, 0.35);
}

a:hover { border-bottom-color: var(--brass-lit); }

/* ── the two states perception keys off: .errmsg -> alert, .notice -> status ─
   Class names are untouchable here. Only their painting changes.            */

.errmsg {
  display: inline-block;
  padding: 9px 14px;
  color: #FFD9DC;
  background: rgba(224, 82, 94, 0.16);
  border: 1px solid rgba(224, 82, 94, 0.42);
  border-left: 3px solid var(--alarm);
  border-radius: 4px;
}

.notice {
  display: inline-block;
  padding: 9px 14px;
  color: #F3E4B4;
  background: rgba(201, 162, 39, 0.13);
  border: 1px solid rgba(201, 162, 39, 0.36);
  border-left: 3px solid var(--brass);
  border-radius: 4px;
}

table.err { margin-bottom: 14px; }

/* ── the nav rail: its own frame document, so its own treatment ──────────── */

body.nav {
  padding: 22px 15px;
  background: linear-gradient(180deg, rgba(4, 24, 26, 0.52), rgba(4, 24, 26, 0.24));
  -webkit-backdrop-filter: var(--frost);
  backdrop-filter: var(--frost);
  border-right: 1px solid var(--edge);
  box-shadow: inset -1px 0 0 rgba(4, 24, 26, 0.4);
  min-height: 100vh;
}

body.nav > table { max-width: none; }

body.nav::before {
  content: "CoreBank Teller";
  display: block;
  margin-bottom: 4px;
  padding-bottom: 14px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
  border-bottom: 1px solid var(--edge);
}

body.nav > table > tbody > tr > td.tdl {
  padding: 0;
  background: none;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

body.nav td.c3 { padding: 0; }

body.nav a {
  display: block;
  padding: 8px 10px;
  margin-top: 6px;
  color: var(--ink-dim);
  font-size: 13px;
  border: 1px solid transparent;
  border-radius: 4px;
}

body.nav a:hover {
  color: var(--ink);
  background: rgba(234, 242, 238, 0.07);
  border-color: var(--edge);
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
</style>`;
