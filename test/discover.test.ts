// discover.test.ts — tests for the built-in web fetcher that discovers and
// generates knowledge.yaml manifests from URLs.
//
// No real HTTP calls are made — these test the pure functions only.

import { describe, it, expect } from "vitest";
import {
  wellKnownPaths,
  slugify,
  extractTitle,
  extractHeadings,
  extractLinks,
  extractFirstParagraph,
  parseRobotsTxt,
  isDisallowed,
  generateWebManifest,
  type CrawlResult,
  type PageInfo,
} from "../src/discover.js";

// ── wellKnownPaths / URL transforms ─────────────────────────────────

describe("wellKnownPaths", () => {
  it("generates standard well-known paths for a regular URL", () => {
    const paths = wellKnownPaths("https://example.com/some/page");
    expect(paths).toContain("https://example.com/knowledge.yaml");
    expect(paths).toContain("https://example.com/.well-known/kcp/knowledge.yaml");
  });

  it("transforms GitHub URLs to raw.githubusercontent.com", () => {
    const paths = wellKnownPaths("https://github.com/Cantara/kcp-agent");
    expect(paths).toContain("https://raw.githubusercontent.com/Cantara/kcp-agent/main/knowledge.yaml");
  });

  it("strips .git suffix from GitHub repo names", () => {
    const paths = wellKnownPaths("https://github.com/owner/repo.git");
    expect(paths).toContain("https://raw.githubusercontent.com/owner/repo/main/knowledge.yaml");
  });

  it("transforms GitLab URLs to raw paths", () => {
    const paths = wellKnownPaths("https://gitlab.com/owner/project");
    expect(paths).toContain("https://gitlab.com/owner/project/-/raw/main/knowledge.yaml");
  });

  it("strips .git suffix from GitLab repo names", () => {
    const paths = wellKnownPaths("https://gitlab.com/owner/project.git");
    expect(paths).toContain("https://gitlab.com/owner/project/-/raw/main/knowledge.yaml");
  });

  it("does not produce GitHub/GitLab paths for non-matching URLs", () => {
    const paths = wellKnownPaths("https://docs.example.com/guide");
    expect(paths).toHaveLength(2); // only the two standard paths
    expect(paths.every((p) => !p.includes("githubusercontent"))).toBe(true);
  });
});

// ── slugify ─────────────────────────────────────────────────────────

describe("slugify", () => {
  it("converts URL paths to valid IDs", () => {
    expect(slugify("/docs/api/auth")).toBe("docs-api-auth");
    expect(slugify("/about")).toBe("about");
    expect(slugify("/docs/getting-started/")).toBe("docs-getting-started");
  });

  it("handles root path", () => {
    expect(slugify("/")).toBe("index");
  });

  it("strips file extensions", () => {
    expect(slugify("/docs/guide.html")).toBe("docs-guide");
    expect(slugify("/page.php")).toBe("page");
  });

  it("lowercases and sanitizes", () => {
    expect(slugify("/API/V2/Users")).toBe("api-v2-users");
    expect(slugify("/docs/my page!")).toBe("docs-my-page");
  });

  it("collapses multiple dashes", () => {
    expect(slugify("/docs///api")).toBe("docs-api");
    expect(slugify("/a--b--c")).toBe("a-b-c");
  });

  it("handles empty or whitespace-only path", () => {
    expect(slugify("")).toBe("index");
  });
});

// ── HTML extraction helpers ─────────────────────────────────────────

describe("extractTitle", () => {
  it("extracts title from HTML", () => {
    expect(extractTitle("<html><head><title>My Page</title></head></html>")).toBe("My Page");
  });

  it("returns empty string when no title", () => {
    expect(extractTitle("<html><body>hello</body></html>")).toBe("");
  });

  it("strips tags from title content", () => {
    expect(extractTitle("<title><b>Bold</b> Title</title>")).toBe("Bold Title");
  });
});

describe("extractHeadings", () => {
  it("extracts h1-h3 headings", () => {
    const html = `
      <h1>Main Title</h1>
      <h2>Section One</h2>
      <h3>Subsection</h3>
      <h4>Should Not Appear</h4>
    `;
    const headings = extractHeadings(html);
    expect(headings).toEqual(["Main Title", "Section One", "Subsection"]);
  });

  it("strips inline tags from headings", () => {
    const html = '<h1><a href="/x">Linked Heading</a></h1>';
    expect(extractHeadings(html)).toEqual(["Linked Heading"]);
  });

  it("returns empty array for no headings", () => {
    expect(extractHeadings("<p>Just a paragraph</p>")).toEqual([]);
  });
});

describe("extractLinks", () => {
  it("extracts and resolves relative links", () => {
    const html = '<a href="/about">About</a><a href="https://other.com/x">Other</a>';
    const links = extractLinks(html, "https://example.com/page");
    expect(links).toContain("https://example.com/about");
    expect(links).toContain("https://other.com/x");
  });

  it("handles links with single quotes (does not match)", () => {
    const html = "<a href='/single'>Single</a>";
    // The regex requires double quotes — single-quoted links are not matched
    expect(extractLinks(html, "https://example.com")).toEqual([]);
  });
});

describe("extractFirstParagraph", () => {
  it("extracts the first paragraph", () => {
    const html = "<p>Hello world. This is a test.</p><p>Second paragraph.</p>";
    expect(extractFirstParagraph(html)).toBe("Hello world. This is a test.");
  });

  it("strips HTML tags from paragraph content", () => {
    const html = "<p>Hello <b>bold</b> world</p>";
    expect(extractFirstParagraph(html)).toBe("Hello bold world");
  });

  it("returns empty string when no paragraph", () => {
    expect(extractFirstParagraph("<div>No paragraphs</div>")).toBe("");
  });
});

// ── robots.txt parsing ──────────────────────────────────────────────

describe("parseRobotsTxt", () => {
  it("parses basic disallow rules for user-agent *", () => {
    const txt = [
      "User-agent: *",
      "Disallow: /admin",
      "Disallow: /private/",
      "Allow: /public",
    ].join("\n");
    const disallowed = parseRobotsTxt(txt);
    expect(disallowed).toContain("/admin");
    expect(disallowed).toContain("/private/");
    expect(disallowed).not.toContain("/public");
  });

  it("ignores rules for specific user agents", () => {
    const txt = [
      "User-agent: Googlebot",
      "Disallow: /google-only",
      "",
      "User-agent: *",
      "Disallow: /blocked",
    ].join("\n");
    const disallowed = parseRobotsTxt(txt);
    expect(disallowed).toContain("/blocked");
    expect(disallowed).not.toContain("/google-only");
  });

  it("handles empty robots.txt", () => {
    expect(parseRobotsTxt("")).toEqual([]);
  });

  it("handles comments", () => {
    const txt = [
      "# This is a comment",
      "User-agent: *",
      "# Another comment",
      "Disallow: /secret",
    ].join("\n");
    expect(parseRobotsTxt(txt)).toContain("/secret");
  });
});

describe("isDisallowed", () => {
  it("matches prefix paths", () => {
    expect(isDisallowed("/admin/users", ["/admin"])).toBe(true);
    expect(isDisallowed("/about", ["/admin"])).toBe(false);
  });

  it("handles exact matches", () => {
    expect(isDisallowed("/private/", ["/private/"])).toBe(true);
  });
});

// ── generateWebManifest ─────────────────────────────────────────────

describe("generateWebManifest", () => {
  function makePage(overrides: Partial<PageInfo> = {}): PageInfo {
    return {
      url: "https://example.com/",
      title: "Example Site",
      headings: ["Getting Started", "Installation"],
      firstParagraph: "Welcome to the example site.",
      path: "/",
      ...overrides,
    };
  }

  it("generates valid YAML with units from crawl pages", () => {
    const crawl: CrawlResult = {
      pages: [
        makePage(),
        makePage({ url: "https://example.com/docs/api", path: "/docs/api", title: "API Reference", headings: ["Endpoints", "Authentication"], firstParagraph: "Full API docs." }),
      ],
      robotsDisallowed: [],
    };
    const yaml = generateWebManifest(crawl);
    expect(yaml).toContain('kcp_version: "0.25"');
    expect(yaml).toContain("project:");
    expect(yaml).toContain("units:");
    expect(yaml).toContain("id: index");
    expect(yaml).toContain("id: docs-api");
    expect(yaml).toContain("scope: global");
    expect(yaml).toContain("audience: [agent, human]");
  });

  it("uses the explicit project name when provided", () => {
    const crawl: CrawlResult = { pages: [makePage()], robotsDisallowed: [] };
    const yaml = generateWebManifest(crawl, { project: "My Project" });
    expect(yaml).toContain("My Project");
  });

  it("uses the publisher when provided", () => {
    const crawl: CrawlResult = { pages: [makePage()], robotsDisallowed: [] };
    const yaml = generateWebManifest(crawl, { publisher: "Acme Corp" });
    expect(yaml).toContain("Acme Corp");
  });

  it("derives project name from root page title", () => {
    const crawl: CrawlResult = {
      pages: [makePage({ title: "Awesome Tool" })],
      robotsDisallowed: [],
    };
    const yaml = generateWebManifest(crawl);
    expect(yaml).toContain("Awesome Tool");
  });

  it("caps at 30 units, keeping pages with the most content", () => {
    const pages: PageInfo[] = [];
    for (let i = 0; i < 40; i++) {
      pages.push(makePage({
        url: `https://example.com/page/${i}`,
        path: `/page/${i}`,
        title: `Page ${i}`,
        headings: i < 5 ? ["H1", "H2", "H3", "H4", "H5"] : [], // first 5 pages have more headings
        firstParagraph: `Content for page ${i}`,
      }));
    }
    const crawl: CrawlResult = { pages, robotsDisallowed: [] };
    const yaml = generateWebManifest(crawl);

    // Count the number of "- id:" occurrences
    const unitCount = (yaml.match(/- id:/g) || []).length;
    expect(unitCount).toBe(30);

    // The pages with more headings should be prioritized
    expect(yaml).toContain("page-0");
    expect(yaml).toContain("page-1");
    expect(yaml).toContain("page-2");
    expect(yaml).toContain("page-3");
    expect(yaml).toContain("page-4");
  });

  it("generates triggers from headings", () => {
    const crawl: CrawlResult = {
      pages: [makePage({ headings: ["Authentication Guide", "API Keys"] })],
      robotsDisallowed: [],
    };
    const yaml = generateWebManifest(crawl);
    expect(yaml).toContain("authentication");
    expect(yaml).toContain("guide");
    expect(yaml).toContain("keys");
  });

  it("truncates long intents", () => {
    const longTitle = "A".repeat(80);
    const longParagraph = "B".repeat(80);
    const crawl: CrawlResult = {
      pages: [makePage({ title: longTitle, firstParagraph: longParagraph })],
      robotsDisallowed: [],
    };
    const yaml = generateWebManifest(crawl);
    // The intent should be truncated with "..."
    expect(yaml).toContain("...");
  });

  it("handles empty crawl result", () => {
    const crawl: CrawlResult = { pages: [], robotsDisallowed: [] };
    const yaml = generateWebManifest(crawl);
    expect(yaml).toContain("units:");
    // No units should be generated
    expect(yaml).not.toContain("- id:");
  });

  it("produces unique unit IDs from different URL paths", () => {
    const crawl: CrawlResult = {
      pages: [
        makePage({ url: "https://example.com/docs/api/auth", path: "/docs/api/auth", title: "Auth" }),
        makePage({ url: "https://example.com/docs/api/users", path: "/docs/api/users", title: "Users" }),
        makePage({ url: "https://example.com/about", path: "/about", title: "About" }),
      ],
      robotsDisallowed: [],
    };
    const yaml = generateWebManifest(crawl);
    expect(yaml).toContain("id: docs-api-auth");
    expect(yaml).toContain("id: docs-api-users");
    expect(yaml).toContain("id: about");
  });
});
