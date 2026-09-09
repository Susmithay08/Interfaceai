# Desktop surface — the seam, not an implementation

There is no desktop adapter here, deliberately. What exists is the seam it would plug into.

A desktop adapter implements `Surface` (`src/surface/surface.ts`) and nothing above it changes:

- `observe()` walks the platform accessibility tree (UI Automation on Windows, AX on macOS, AT-SPI
  on Linux) and emits the same normalized `Observation`: role, accessible name, value, state,
  a `ScopePath`, and anchors. Every one of those has a direct counterpart in those APIs.
- `execute()` takes a `ResolvedAction` carrying an ephemeral `Ref` — an index into the handles from
  the last observation — and invokes the native pattern (Invoke, Value, SelectionItem).
- `capture()` screenshots the window.
- `instrument()` subscribes to platform event hooks so an operator's manual actions report into
  evidence exactly as the web instrumentation does.

`ScopePath` is why this works. A scope segment is addressed by *how* it is found — `name`, `title`,
`urlPath`, `index` — never by a CSS selector or an XPath. A window title and a pane name map onto
the same three cases a frame name and a document title do.

`src/resolution/` needs no change at all: it is pure, takes `(descriptor, observation)`, and has
never known what a browser is. `tests/unit/architecture.test.ts` holds that line.

The reason this is a README rather than code: an adapter that has never been run against a real
desktop application would prove nothing, and would quietly claim more than the design has earned.
