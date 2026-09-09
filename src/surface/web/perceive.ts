/**
 * Surface-specific perception: DOM + accessibility information -> RawNode[].
 *
 * This function is serialized into the page, so it must be self-contained and may not
 * reference anything from the module scope. It is the ONLY place in the system that knows
 * about the DOM; everything above it works on the normalized Observation.
 */
export interface RawNode {
  index: number;
  role: string;
  name?: string;
  value?: string;
  visible: boolean;
  disabled?: boolean;
  required?: boolean;
  region?: string;
  anchors: { kind: string; text: string }[];
  attrs?: Record<string, string>;
}

export function collectNodes(): RawNode[] {
  const out: RawNode[] = [];
  const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.getAttribute("type") ?? "text").toLowerCase();
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "password" || t === "text" || t === "search" || t === "tel" || t === "email") {
        return "textbox";
      }
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "button") return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "table") return "table";
    if (tag === "td" || tag === "th") return "cell";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "form") return "form";
    if (tag === "span" || tag === "div" || tag === "p") {
      const cls = el.className && typeof el.className === "string" ? el.className : "";
      if (/\berrmsg\b/.test(cls)) return "alert";
      if (/\bnotice\b/.test(cls)) return "status";
      return null;
    }
    return null;
  };

  const labelFor = (el: Element): string | undefined => {
    const id = el.getAttribute("id");
    if (!id) return undefined;
    const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    return lbl ? norm(lbl.textContent) : undefined;
  };

  const nameOf = (el: Element, role: string): string | undefined => {
    const aria = el.getAttribute("aria-label");
    if (aria) return norm(aria);
    const label = labelFor(el);
    if (label) return label;
    if (role === "button" && el.tagName.toLowerCase() === "input") {
      return norm(el.getAttribute("value"));
    }
    if (role === "table") {
      // Legacy tables have no caption; the nearest preceding heading names them.
      let p: Element | null = el.previousElementSibling;
      while (p) {
        if (/^h[1-6]$/i.test(p.tagName)) return norm(p.textContent);
        p = p.previousElementSibling;
      }
      return undefined;
    }
    const text = norm(el.textContent);
    return text.length > 0 && text.length <= 120 ? text : undefined;
  };

  /** Nearest preceding heading in document order - the only region signal this app offers. */
  const regionOf = (el: Element): string | undefined => {
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"));
    let best: string | undefined;
    for (const h of headings) {
      const pos = h.compareDocumentPosition(el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) best = norm(h.textContent);
    }
    return best;
  };

  const cellAnchors = (el: Element): { kind: string; text: string }[] => {
    const anchors: { kind: string; text: string }[] = [];
    const row = el.closest("tr");
    const table = el.closest("table");
    if (!row || !table) return anchors;

    const cells = Array.from(row.children);
    const colIndex = cells.indexOf(el as Element);

    // Row key: the first cell of this row (the row's identity in a legacy grid).
    const first = cells[0];
    if (first && first !== el) anchors.push({ kind: "rowHeader", text: norm(first.textContent) });
    if (first === el) anchors.push({ kind: "rowHeader", text: norm(first.textContent) });

    // Column header: same index in the header row.
    const rows = Array.from(table.querySelectorAll("tr"));
    const headerRow = rows.find((r) => r.querySelector("th")) ?? rows[0];
    if (headerRow && headerRow !== row && colIndex >= 0) {
      const headerCell = headerRow.children[colIndex];
      if (headerCell) anchors.push({ kind: "columnHeader", text: norm(headerCell.textContent) });
    }
    return anchors;
  };

  const isVisible = (el: Element): boolean => {
    const he = el as HTMLElement;
    if (he.hidden) return false;
    const style = window.getComputedStyle(he);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return he.offsetParent !== null || style.position === "fixed" || he.tagName === "BODY";
  };

  const all = Array.from(document.querySelectorAll("*"));
  for (let domIndex = 0; domIndex < all.length; domIndex++) {
    const el = all[domIndex]!;
    const role = roleOf(el);
    if (!role) continue;

    const name = nameOf(el, role);
    const anchors: { kind: string; text: string }[] = [];

    const label = labelFor(el);
    if (label) anchors.push({ kind: "label", text: label });
    if (role === "cell") anchors.push(...cellAnchors(el));

    const region = regionOf(el);
    if (region) anchors.push({ kind: "sectionHeading", text: region });

    let value: string | undefined;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      value = (el as HTMLInputElement).value;
    } else {
      const t = norm(el.textContent);
      value = t.length > 0 && t.length <= 200 ? t : undefined;
    }

    const attrs: Record<string, string> = { tagName: tag };
    const inputType = el.getAttribute("type");
    if (inputType) attrs["inputType"] = inputType;

    const node: RawNode = {
      // Index into document.querySelectorAll("*"), so the Node side can address the
      // element with locator("*").nth(index). Must NOT be a filtered counter.
      index: domIndex,
      role,
      visible: isVisible(el),
      anchors,
      attrs,
    };
    if (name !== undefined) node.name = name;
    if (value !== undefined) node.value = value;
    if (region !== undefined) node.region = region;
    if ((el as HTMLInputElement).disabled) node.disabled = true;
    if (el.hasAttribute("required")) node.required = true;

    out.push(node);
  }
  return out;
}
