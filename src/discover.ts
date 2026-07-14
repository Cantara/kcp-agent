// Built-in web fetcher — discover existing knowledge.yaml manifests and
// generate draft manifests from crawled web content.
//
// All network I/O is routed through the SSRF-guarded fetch from fetch.ts.
// HTML parsing is intentionally regex-based — no jsdom or cheerio dependency.
// The generated manifest is a starting draft, not production-ready output.

import { guardedFetchText, type FetchGuard } from "./fetch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoverResult {
  found: boolean;
  url?: string;
  manifest?: {
    project: string;
    version: string;
    unitCount: number;
    kcpVersion?: string;
  };
}

export interface CrawlOptions {
  /** Maximum pages to crawl. Default 20, hard cap 100. */
  maxPages?: number;
  /** Delay in ms between fetches. Default 1000. */
  delay?: number;
  /** Restrict crawl to same origin. Default true. */
  sameOrigin?: boolean;
}

export interface PageInfo {
  url: string;
  title: string;
  headings: string[];
  firstParagraph: string;
  path: string;
}

export interface CrawlResult {
  pages: PageInfo[];
  robotsDisallowed: string[];
}

export interface GenOptions {
  project?: string;
  publisher?: string;
}

// ---------------------------------------------------------------------------
// HTML helpers — intentionally minimal, regex-based
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>(.*?)<\/title>/is);
  return m ? stripTags(m[1]).trim() : "";
}

export function extractHeadings(html: string): string[] {
  const headings: string[] = [];
  const re = /<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = stripTags(m[1]).trim();
    if (text) headings.push(text);
  }
  return headings;
}

export function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const re = /<a[^>]+href="([^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const resolved = new URL(m[1], baseUrl).href;
      links.push(resolved);
    } catch {
      // skip malformed URLs
    }
  }
  return links;
}

export function extractFirstParagraph(html: string): string {
  const m = html.match(/<p[^>]*>(.*?)<\/p>/is);
  return m ? stripTags(m[1]).trim() : "";
}

// ---------------------------------------------------------------------------
// Robots.txt
// ---------------------------------------------------------------------------

export function parseRobotsTxt(text: string): string[] {
  const disallowed: string[] = [];
  let inUserAgentAll = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const uaMatch = line.match(/^user-agent:\s*(.+)$/i);
    if (uaMatch) {
      inUserAgentAll = uaMatch[1].trim() === "*";
      continue;
    }

    if (inUserAgentAll) {
      const disMatch = line.match(/^disallow:\s*(.+)$/i);
      if (disMatch) {
        const path = disMatch[1].trim();
        if (path) disallowed.push(path);
      }
    }
  }
  return disallowed;
}

export function isDisallowed(urlPath: string, disallowedPaths: string[]): boolean {
  return disallowedPaths.some((d) => urlPath.startsWith(d));
}

// ---------------------------------------------------------------------------
// URL transforms for well-known hosting platforms
// ---------------------------------------------------------------------------

export function wellKnownPaths(rawUrl: string): string[] {
  const url = new URL(rawUrl);
  const origin = url.origin;
  const paths: string[] = [];

  // Standard well-known paths
  paths.push(`${origin}/knowledge.yaml`);
  paths.push(`${origin}/.well-known/kcp/knowledge.yaml`);

  // GitHub: github.com/{owner}/{repo} → raw.githubusercontent.com/{owner}/{repo}/main/knowledge.yaml
  const ghMatch = url.hostname === "github.com" && url.pathname.match(/^\/([^/]+)\/([^/]+)/);
  if (ghMatch) {
    const [, owner, repo] = ghMatch;
    const cleanRepo = repo.replace(/\.git$/, "");
    paths.push(`https://raw.githubusercontent.com/${owner}/${cleanRepo}/main/knowledge.yaml`);
  }

  // GitLab: gitlab.com/{owner}/{repo} → gitlab.com/{owner}/{repo}/-/raw/main/knowledge.yaml
  const glMatch = url.hostname === "gitlab.com" && url.pathname.match(/^\/([^/]+)\/([^/]+)/);
  if (glMatch) {
    const [, owner, repo] = glMatch;
    const cleanRepo = repo.replace(/\.git$/, "");
    paths.push(`https://gitlab.com/${owner}/${cleanRepo}/-/raw/main/knowledge.yaml`);
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Slugification
// ---------------------------------------------------------------------------

export function slugify(urlPath: string): string {
  return urlPath
    .replace(/^\/+/, "")       // strip leading slashes
    .replace(/\/+$/, "")       // strip trailing slashes
    .replace(/\.[^.]+$/, "")   // strip file extension
    .replace(/[^a-zA-Z0-9/-]/g, "-")  // non-alphanum to dash
    .replace(/\//g, "-")       // slashes to dashes
    .replace(/-+/g, "-")       // collapse runs
    .replace(/^-|-$/g, "")     // trim leading/trailing dashes
    .toLowerCase()
    || "index";
}

// ---------------------------------------------------------------------------
// 1. discoverManifest — check well-known paths for a knowledge.yaml
// ---------------------------------------------------------------------------

export async function discoverManifest(url: string, guard?: FetchGuard): Promise<DiscoverResult> {
  const candidates = wellKnownPaths(url);
  const fetchGuard = guard ?? {};

  for (const candidate of candidates) {
    try {
      const text = await guardedFetchText(candidate, fetchGuard);
      // Quick heuristic: a knowledge.yaml should contain "project:" and "units:"
      if (!text.includes("project:") && !text.includes("project :")) continue;

      // Parse just enough to extract summary info
      const projectMatch = text.match(/^project:\s*["']?(.+?)["']?\s*$/m);
      const versionMatch = text.match(/^version:\s*["']?(.+?)["']?\s*$/m);
      const kcpMatch = text.match(/^kcp_version:\s*["']?(.+?)["']?\s*$/m);
      const unitMatches = text.match(/^\s*- id:/gm);

      return {
        found: true,
        url: candidate,
        manifest: {
          project: projectMatch ? projectMatch[1].trim() : "(unnamed)",
          version: versionMatch ? versionMatch[1].trim() : "0.0.0",
          unitCount: unitMatches ? unitMatches.length : 0,
          kcpVersion: kcpMatch ? kcpMatch[1].trim() : undefined,
        },
      };
    } catch {
      // This candidate didn't work — try the next one
    }
  }

  return { found: false };
}

// ---------------------------------------------------------------------------
// 2. crawlSite — breadth-first same-origin crawl
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function crawlSite(url: string, options: CrawlOptions = {}, guard?: FetchGuard): Promise<CrawlResult> {
  const maxPages = Math.min(Math.max(options.maxPages ?? 20, 1), 100);
  const delay = options.delay ?? 1000;
  const sameOrigin = options.sameOrigin ?? true;
  const fetchGuard = guard ?? {};

  const origin = new URL(url).origin;

  // Fetch robots.txt first
  let robotsDisallowed: string[] = [];
  try {
    const robotsText = await guardedFetchText(`${origin}/robots.txt`, fetchGuard);
    robotsDisallowed = parseRobotsTxt(robotsText);
  } catch {
    // No robots.txt or fetch error — crawl everything
  }

  const visited = new Set<string>();
  const queue: string[] = [url];
  const pages: PageInfo[] = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const current = queue.shift()!;
    const normalizedUrl = normalizeUrl(current);

    if (visited.has(normalizedUrl)) continue;
    visited.add(normalizedUrl);

    // Check robots.txt
    const urlPath = new URL(current).pathname;
    if (isDisallowed(urlPath, robotsDisallowed)) continue;

    // Rate limit (skip delay for the first page)
    if (pages.length > 0) await sleep(delay);

    try {
      const html = await guardedFetchText(current, fetchGuard);
      const title = extractTitle(html);
      const headings = extractHeadings(html);
      const firstParagraph = extractFirstParagraph(html);

      pages.push({
        url: current,
        title,
        headings,
        firstParagraph,
        path: urlPath,
      });

      // Extract and queue links
      const links = extractLinks(html, current);
      for (const link of links) {
        try {
          const linkUrl = new URL(link);
          const linkNormalized = normalizeUrl(link);

          // Skip non-HTTP, fragments, already visited
          if (linkUrl.protocol !== "http:" && linkUrl.protocol !== "https:") continue;
          if (visited.has(linkNormalized)) continue;

          // Same-origin check
          if (sameOrigin && linkUrl.origin !== origin) continue;

          // Skip obvious non-content URLs
          if (/\.(png|jpg|jpeg|gif|svg|css|js|woff|woff2|ttf|eot|ico|pdf|zip|tar|gz)$/i.test(linkUrl.pathname)) continue;

          queue.push(link);
        } catch {
          // Skip malformed URLs
        }
      }
    } catch {
      // Skip pages that fail to fetch
    }
  }

  return { pages, robotsDisallowed };
}

function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    // Strip fragment and trailing slash for dedup
    u.hash = "";
    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    u.pathname = path;
    return u.href;
  } catch {
    return rawUrl;
  }
}

// ---------------------------------------------------------------------------
// 3. generateWebManifest — produce a knowledge.yaml from crawl results
// ---------------------------------------------------------------------------

const MAX_UNITS = 30;

export function generateWebManifest(crawl: CrawlResult, options: GenOptions = {}): string {
  let pages = crawl.pages;

  // Cap at MAX_UNITS — prefer pages with the most headings/content
  if (pages.length > MAX_UNITS) {
    pages = [...pages]
      .sort((a, b) => {
        const scoreA = a.headings.length + (a.firstParagraph ? 1 : 0) + (a.title ? 1 : 0);
        const scoreB = b.headings.length + (b.firstParagraph ? 1 : 0) + (b.title ? 1 : 0);
        return scoreB - scoreA;
      })
      .slice(0, MAX_UNITS);
  }

  // Derive project name: explicit option, root page title, or domain
  const rootPage = crawl.pages[0];
  let project = options.project ?? "";
  if (!project && rootPage) {
    project = rootPage.title || domainName(rootPage.url);
  }
  if (!project) project = "website";

  const lines: string[] = [];
  lines.push("# Auto-generated by kcp-agent discover — review before use");
  lines.push(`# TODO: review and refine this manifest`);
  lines.push("");
  lines.push(`kcp_version: "0.26"`);
  lines.push(`project: ${yamlQuote(project)}`);
  lines.push(`version: "1.0.0"`);
  if (options.publisher) {
    lines.push(`publisher: ${yamlQuote(options.publisher)}`);
  }
  lines.push("");
  lines.push("units:");

  for (const page of pages) {
    const id = slugify(page.path);
    const intent = buildIntent(page);
    const triggers = buildTriggers(page);

    lines.push(`  - id: ${yamlQuote(id)}`);
    lines.push(`    path: ${yamlQuote(page.url)}`);
    lines.push(`    intent: ${yamlQuote(intent)}`);
    lines.push(`    scope: global`);
    lines.push(`    audience: [agent, human]`);
    if (triggers.length > 0) {
      lines.push(`    triggers: [${triggers.map(yamlQuote).join(", ")}]`);
    } else {
      lines.push(`    triggers: []`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function buildIntent(page: PageInfo): string {
  const parts: string[] = [];
  if (page.title) parts.push(page.title);
  if (page.firstParagraph) parts.push(page.firstParagraph);
  const joined = parts.join(" — ");
  // Truncate to ~100 chars at a word boundary
  if (joined.length <= 100) return joined;
  const truncated = joined.slice(0, 100).replace(/\s+\S*$/, "");
  return truncated + "...";
}

function buildTriggers(page: PageInfo): string[] {
  const keywords = new Set<string>();
  for (const heading of page.headings) {
    // Split headings into individual keywords
    const words = heading
      .toLowerCase()
      .split(/[\s,;:—–\-/|]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2 && !/^(the|and|for|with|from|that|this|are|was|has|have|not|but|its|our|your)$/.test(w));
    for (const w of words) keywords.add(w);
  }
  return [...keywords].slice(0, 15); // Cap trigger count
}

function domainName(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    // Strip www. and TLD for a cleaner project name
    return hostname.replace(/^www\./, "").split(".")[0] || hostname;
  } catch {
    return "website";
  }
}

function yamlQuote(value: string): string {
  // Quote strings that contain special YAML characters or are empty
  if (!value || /[:{}\[\],&*?|>!%@`#'"\n\r]/.test(value) || value.includes(" - ")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}
