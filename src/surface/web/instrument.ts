/** Name of the page-side binding the operator's actions report through. */
export const HUMAN_ACTION_HOOK = "__recordHumanAction";

/**
 * Installed while the operator holds the session, so the human's manual steps are captured
 * as evidence rather than being an unrecorded gap in the run.
 *
 * Values are reported, but the evidence sink redacts them on the way to disk.
 */
export const instrumentationScript = `
(() => {
  if (window.__humanActionInstrumented) return;
  window.__humanActionInstrumented = true;

  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();

  const describe = (el) => {
    if (!el || !el.tagName) return {};
    const tag = el.tagName.toLowerCase();
    let role = tag;
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      role = (t === "submit" || t === "button") ? "button" : "textbox";
    } else if (tag === "a") role = "link";
    else if (tag === "button") role = "button";

    let name = el.getAttribute("aria-label") || "";
    if (!name && el.id) {
      const lbl = document.querySelector('label[for="' + el.id + '"]');
      if (lbl) name = norm(lbl.textContent);
    }
    if (!name && role === "button" && tag === "input") name = el.getAttribute("value") || "";
    if (!name) name = norm(el.textContent).slice(0, 80);
    return { role: role, accessibleName: name };
  };

  const report = (actionKind, el, value) => {
    try {
      const d = describe(el);
      window.${HUMAN_ACTION_HOOK}({
        actionKind: actionKind,
        role: d.role,
        accessibleName: d.accessibleName,
        value: value === undefined ? undefined : String(value)
      });
    } catch (e) { /* binding not available in this frame */ }
  };

  document.addEventListener("click", (e) => report("click", e.target), true);
  document.addEventListener("change", (e) => report("change", e.target, e.target && e.target.value), true);
  document.addEventListener("submit", (e) => report("submit", e.target), true);
})();
`;
