import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const SRC = join(ROOT, "src");

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

// A module specifier never contains whitespace, which keeps prose in string literals out.
const IMPORT = /\bfrom\s+["']([^"'\s]+)["']/g;

function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(IMPORT)].map((m) => m[1]!);
}

/** Every module `entry` reaches, directly or through any chain of local imports. */
function closureOf(entry: string): { locals: Set<string>; packages: Set<string> } {
  const locals = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    for (const spec of importsOf(file)) {
      if (!spec.startsWith(".")) {
        packages.add(spec);
        continue;
      }
      const resolved = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (locals.has(resolved)) continue;
      locals.add(resolved);
      queue.push(resolved);
    }
  }
  return { locals, packages };
}

const rel = (p: string): string => relative(ROOT, p).replace(/\\/g, "/");

describe("module graph", () => {
  const replayFiles = files(join(SRC, "replay"));

  it("replay never reaches the agent, the LLM seam, or a provider SDK", () => {
    for (const entry of replayFiles) {
      const { locals, packages } = closureOf(entry);
      const reached = [...locals].map(rel);

      // This is the executable form of the central claim: replay is deterministic
      // because there is no code path from it to a language model, at any depth.
      expect(reached.filter((p) => p.startsWith("src/agent/")), rel(entry)).toEqual([]);
      expect([...packages].filter((p) => /groq|openai|anthropic|ai-sdk/i.test(p))).toEqual([]);
    }
  });

  it("replay depends on no browser driver, so it is surface-neutral", () => {
    for (const entry of replayFiles) {
      const { locals, packages } = closureOf(entry);
      expect([...packages].filter((p) => /playwright|puppeteer|selenium/i.test(p))).toEqual([]);
      expect([...locals].map(rel).filter((p) => p.startsWith("src/surface/web/"))).toEqual([]);
    }
  });

  it("resolution is pure: it imports nothing outside the model", () => {
    for (const entry of files(join(SRC, "resolution"))) {
      const { locals, packages } = closureOf(entry);
      expect([...packages].filter((p) => p !== "zod")).toEqual([]);
      const outside = [...locals]
        .map(rel)
        .filter((p) => !p.startsWith("src/model/") && !p.startsWith("src/resolution/"));
      expect(outside, rel(entry)).toEqual([]);
    }
  });

  it("the model layer depends on nothing but zod", () => {
    for (const entry of files(join(SRC, "model"))) {
      const { locals, packages } = closureOf(entry);
      expect([...packages].filter((p) => p !== "zod")).toEqual([]);
      expect([...locals].map(rel).filter((p) => !p.startsWith("src/model/"))).toEqual([]);
    }
  });

  it("only the provider adapters know which vendor is answering", () => {
    for (const entry of files(SRC)) {
      const named = importsOf(entry).filter((s) => /^groq-sdk|^openai$|^@anthropic-ai/.test(s));
      if (named.length === 0) continue;
      expect(rel(entry)).toMatch(/^src\/agent\/llm\/providers\//);
    }
  });
});
