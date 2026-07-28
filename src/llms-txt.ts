// llms.txt → knowledge.yaml.
//
// llms.txt is a flat link list: a title, a summary, and sections of links. It has no
// audiences, no temporal validity, no signatures, no payment terms and no federation — all
// the things a knowledge.yaml exists to carry. It is also what publishers actually adopted,
// at a scale knowledge.yaml has not reached.
//
// So this converts rather than competes: an existing llms.txt becomes a *draft* manifest,
// with every field the source could not express marked TODO rather than invented. A
// converted manifest that silently claimed an audience or a validity window would be
// asserting something the publisher never said, which is worse than leaving it blank.
//
// Deterministic — no model call. A publisher can re-run it and get the same file, and it
// can be tested.

import { readFile } from "node:fs/promises";
import { guardedFetchText, type FetchGuard } from "./fetch.js";
import { relativeUnitPath } from "./discover.js";

const KCP_VERSION = "0.30";

export interface LlmsTxtLink {
  title: string;
  url: string;
  description?: string;
}

export interface LlmsTxtSection {
  name: string;
  links: LlmsTxtLink[];
}

export interface LlmsTxtDoc {
  title: string;
  summary?: string;
  sections: LlmsTxtSection[];
}

export interface GenerateOptions {
  publisher?: string;
  /** Overrides the H1 as the project name. */
  project?: string;
}

const H1 = /^#\s+(.+?)\s*$/;
const H2 = /^##\s+(.+?)\s*$/;
const QUOTE = /^>\s*(.+?)\s*$/;
/** `- [title](url)` with an optional `: description` tail. */
const LINK = /^[-*]\s*\[([^\]]+)\]\(([^)]+)\)\s*(?::\s*(.*))?$/;

export function parseLlmsTxt(text: string): LlmsTxtDoc {
  const doc: LlmsTxtDoc = { title: "", sections: [] };
  let current: LlmsTxtSection | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const h2 = H2.exec(line);
    if (h2) {
      current = { name: h2[1], links: [] };
      doc.sections.push(current);
      continue;
    }

    // Checked after H2 because `##` also matches `#`.
    const h1 = H1.exec(line);
    if (h1 && !doc.title) {
      doc.title = h1[1];
      continue;
    }

    // The summary is the first blockquote, before any section.
    const quote = QUOTE.exec(line);
    if (quote && !doc.summary && !current) {
      doc.summary = quote[1];
      continue;
    }

    const link = LINK.exec(line);
    if (link && current) {
      const description = link[3]?.trim();
      current.links.push({
        title: link[1].trim(),
        url: link[2].trim(),
        ...(description ? { description } : {}),
      });
    }
    // Anything else is prose. The format permits it and it carries no unit.
  }

  return doc;
}

export function generateManifestFromLlmsTxt(doc: LlmsTxtDoc, options: GenerateOptions = {}): string {
  const entries = doc.sections.flatMap((s) => s.links.map((link) => ({ link, section: s.name })));
  if (entries.length === 0) {
    // Emitting an empty `units:` list would produce a manifest that validates and describes
    // nothing — a worse outcome than saying the source had nothing to convert.
    throw new Error("llms.txt contains no links — nothing to convert");
  }

  const project = options.project ?? doc.title ?? "";
  const lines: string[] = [];

  lines.push("# Drafted by kcp-agent init --from-llms-txt — review before use.");
  lines.push("#");
  lines.push("# Converted from an llms.txt, which cannot express audiences, temporal validity,");
  lines.push("# signatures, payment terms or federation. Those are left out rather than guessed:");
  lines.push("# the source never said them. See the TODOs below for what to add next.");
  lines.push("");
  lines.push(`kcp_version: ${yamlQuote(KCP_VERSION)}`);
  lines.push(`project: ${yamlQuote(project || "website")}`);
  lines.push(`version: "1.0.0"`);
  if (options.publisher) lines.push(`publisher: ${yamlQuote(options.publisher)}`);
  if (doc.summary) lines.push(`intent: ${yamlQuote(doc.summary)}`);
  lines.push("");
  lines.push("# TODO: add `signing:` once you have a key — an unsigned manifest is usable but");
  lines.push("#       cannot be verified, and a consumer running --require-signature will skip it.");
  lines.push("# TODO: set `valid_from` / `valid_until` on units that go stale.");
  lines.push("# TODO: narrow `audience:` per unit — everything below is open to agent and human.");
  lines.push("");

  // A unit path is a file relative to the manifest (SPEC §4), so an absolute URL cannot be
  // one. A publisher runs this on their own site, so same-origin links relativise cleanly.
  // Links to *other* origins are a different thing entirely — federation — and are listed as
  // TODOs rather than emitted as units that would fail validation.
  const origin = dominantOrigin(entries.map((e) => e.link.url));
  const offSite = entries.filter((e) => originOf(e.link.url) && originOf(e.link.url) !== origin);
  const onSite = entries.filter((e) => !offSite.includes(e));

  if (onSite.length === 0) {
    throw new Error("llms.txt contains no links — nothing to convert");
  }

  if (offSite.length > 0) {
    lines.push(`# TODO: ${offSite.length} link(s) point at other origins and are not units.`);
    lines.push("#       Add them under `manifests:` if they publish their own knowledge.yaml:");
    for (const e of offSite.slice(0, 10)) lines.push(`#         ${e.link.url}`);
    lines.push("");
  }

  lines.push("units:");

  const used = new Set<string>();
  for (const { link, section } of onSite) {
    const id = uniqueId(slug(link.title) || slug(link.url), used);
    const intent = link.description ?? link.title;
    const triggers = buildTriggers(link.title, section);

    lines.push(`  - id: ${yamlQuote(id)}`);
    lines.push(`    path: ${yamlQuote(relativeUnitPath(link.url))}`);
    lines.push(`    intent: ${yamlQuote(intent)}`);
    lines.push(`    scope: global`);
    lines.push(`    audience: [agent, human]`);
    lines.push(`    triggers: [${triggers.map(yamlQuote).join(", ")}]`);
  }

  lines.push("");
  return lines.join("\n");
}

/** The section is the only grouping llms.txt carries; losing it discards its one structure. */
function buildTriggers(title: string, section: string): string[] {
  const stop = /^(the|and|for|with|from|that|this|are|was|has|have|not|but|its|our|your|a|an|to|of|in|on)$/;
  const words = new Set<string>();
  for (const source of [section, title]) {
    for (const w of source.toLowerCase().split(/[\s,;:—–\-/|()]+/)) {
      const t = w.trim();
      if (t.length > 2 && !stop.test(t)) words.add(t);
    }
  }
  return [...words].slice(0, 8);
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined; // already relative — treat as same-site
  }
}

/** The origin most of the links share: what the publisher's own site is. */
function dominantOrigin(urls: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const u of urls) {
    const o = originOf(u);
    if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [o, n] of counts) if (n > bestN) { best = o; bestN = n; }
  return best;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Two sections may list the same title; unit ids must stay unique. */
function uniqueId(base: string, used: Set<string>): string {
  const stem = base || "unit";
  let id = stem;
  let n = 2;
  while (used.has(id)) id = `${stem}-${n++}`;
  used.add(id);
  return id;
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Load an llms.txt from a URL or a local path.
 *
 * Remote reads go through the same SSRF guard as every other fetch in this codebase — a
 * converter is exactly the sort of "just fetch this one URL" helper that otherwise grows
 * into an open proxy.
 */
export async function loadLlmsTxt(location: string, guard: FetchGuard = {}): Promise<string> {
  if (/^https?:\/\//i.test(location)) return guardedFetchText(location, guard);
  return readFile(location, "utf8");
}

/** `https://acme.dev` or `https://acme.dev/docs/` -> `https://acme.dev/llms.txt`. */
export function llmsTxtUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  return new URL("/llms.txt", u.origin).toString();
}
