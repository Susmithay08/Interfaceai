/**
 * The console shares the teller app's visual language - frosted panels over a guilloché
 * field, one brass accent - so an operator moving between the two windows can see they
 * are in one system.
 *
 * The tokens are duplicated rather than imported from the target app on purpose: an
 * operator tool that imported from the application it supervises would be a dependency
 * pointing the wrong way. The console is meant to outlive any one target.
 *
 * Boldness is spent in exactly one place - who holds the session. At 2am that is the only
 * fact an operator needs before any other, so it gets the brass and everything else stays
 * quiet.
 */
export const CONSOLE_STYLE = `
:root {
  --vault-900: #04181A;
  --brass:     #C9A227;
  --brass-lit: #E3C158;
  --ink:       #EAF2EE;
  --ink-dim:   rgba(234, 242, 238, 0.66);
  --ink-faint: rgba(234, 242, 238, 0.42);
  --pane:      rgba(234, 242, 238, 0.10);
  --pane-lit:  rgba(234, 242, 238, 0.17);
  --edge:      rgba(234, 242, 238, 0.20);
  --frost:     blur(26px) saturate(150%);
}

html { box-sizing: border-box; }
*, *::before, *::after { box-sizing: inherit; }

html::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  background:
    radial-gradient(1100px 760px at 12% -12%, rgba(18, 64, 58, 0.62), transparent 62%),
    radial-gradient(880px 640px at 108% 18%, rgba(201, 162, 39, 0.11), transparent 58%),
    repeating-radial-gradient(circle at 22% 28%, rgba(234,242,238,.045) 0 1px, transparent 1px 7px),
    repeating-radial-gradient(circle at 79% 74%, rgba(234,242,238,.038) 0 1px, transparent 1px 9px),
    repeating-linear-gradient(24deg, rgba(234,242,238,.03) 0 1px, transparent 1px 6px),
    linear-gradient(158deg, #06201F 0%, #0A2E2B 52%, #04181A 100%);
}

body {
  margin: 0 auto;
  padding: 40px 28px 60px;
  max-width: 62rem;
  color: var(--ink);
  font: 14px/1.6 ui-sans-serif, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--brass-lit); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--brass-lit); outline-offset: 2px; }

h1 { margin: 0 0 6px; font-size: 24px; font-weight: 600; letter-spacing: -0.018em; }
h1 small { font-size: 13px; font-weight: 500; color: var(--ink-faint); }
h2 { margin: 30px 0 12px; font-size: 15px; font-weight: 600; }

.back { display: inline-block; margin-bottom: 20px; color: var(--ink-faint); font-size: 13px; }

.panel {
  padding: 22px 24px;
  background: linear-gradient(157deg, var(--pane-lit), var(--pane) 62%);
  -webkit-backdrop-filter: var(--frost);
  backdrop-filter: var(--frost);
  border: 1px solid var(--edge);
  border-radius: 5px;
  box-shadow: 0 24px 54px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.38);
}

/* The one loud element: who is driving the live session right now. */
.control {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 0 0 26px;
  padding: 14px 18px;
  border: 1px solid var(--edge);
  border-radius: 5px;
  background: rgba(4, 24, 26, 0.32);
}
.control .lab { color: var(--ink-faint); font-size: 13px; }
.control .who { font-size: 19px; font-weight: 600; letter-spacing: -0.01em; }
.control .hint { margin-left: auto; color: var(--ink-faint); font-size: 12px; }
.control.is-operator {
  border-color: rgba(201, 162, 39, 0.5);
  background: rgba(201, 162, 39, 0.12);
}
.control.is-operator .who { color: var(--brass-lit); }

table { width: 100%; border-collapse: collapse; }
th {
  padding: 9px 14px;
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: var(--brass-lit);
  border-bottom: 1px solid var(--edge);
  white-space: nowrap;
}
td {
  padding: 11px 14px;
  border-bottom: 1px solid rgba(234, 242, 238, 0.07);
  vertical-align: top;
}
tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: rgba(234, 242, 238, 0.045); }

.tag {
  display: inline-block;
  padding: 2px 9px;
  font-size: 12px;
  border: 1px solid var(--edge);
  border-radius: 3px;
  color: var(--ink-dim);
}
.tag.open {
  color: #F3E4B4;
  border-color: rgba(201,162,39,.40);
  background: rgba(201,162,39,.13);
}
.tag.in_progress {
  color: var(--brass-lit);
  border-color: rgba(201,162,39,.55);
  background: rgba(201,162,39,.20);
}

dl { margin: 0; display: grid; grid-template-columns: 9.5rem 1fr; gap: 10px 20px; }
dt { color: var(--ink-faint); font-size: 13px; }
dd { margin: 0; overflow-wrap: anywhere; }
dd.observed { color: #FFD9DC; }

.empty { padding: 34px 24px; text-align: center; color: var(--ink-faint); }

form { margin: 0; }
.lede { margin: 0 0 14px; max-width: 46rem; color: var(--ink-dim); }

input[type="text"] {
  padding: 9px 12px;
  width: 100%;
  max-width: 30rem;
  color: var(--ink);
  font: inherit;
  background: rgba(4, 24, 26, 0.45);
  border: 1px solid var(--edge);
  border-radius: 4px;
  outline: none;
}
input[type="text"]:focus {
  border-color: var(--brass);
  box-shadow: 0 0 0 3px rgba(201, 162, 39, 0.22);
}

button {
  margin-top: 14px;
  padding: 9px 22px;
  color: var(--vault-900);
  font: inherit;
  font-weight: 600;
  background: linear-gradient(180deg, var(--brass-lit), var(--brass));
  border: 1px solid rgba(201, 162, 39, 0.85);
  border-radius: 4px;
  cursor: pointer;
  box-shadow: 0 6px 16px rgba(201,162,39,.24), inset 0 1px 0 rgba(255,255,255,.36);
}
button:hover { filter: brightness(1.07); }
button:active { transform: translateY(1px); }

@media (max-width: 640px) {
  dl { grid-template-columns: 1fr; gap: 4px 0; }
  dd { margin-bottom: 10px; }
  .control { flex-wrap: wrap; }
  .control .hint { margin-left: 0; width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;
