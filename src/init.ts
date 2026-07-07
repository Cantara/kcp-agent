// Auto-manifest generation — `kcp-agent init` scans a repository and generates
// a draft knowledge.yaml. Fully deterministic (no LLM), the generated manifest
// must pass `kcp-agent validate` with zero errors.
//
// See GitHub issue #76.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, basename, extname, relative } from "node:path";
import { parseManifest } from "./client.js";
import { validateManifest } from "./validate.js";

export interface InitOptions {
  publisher?: string;
  dryRun?: boolean;
  force?: boolean;
}

interface DetectedProject {
  name: string;
  version: string;
  description?: string;
}

interface ScannedUnit {
  id: string;
  path: string;
  intent: string;
  scope: string;
  audience: string[];
  triggers: string[];
  hints?: Record<string, string>;
  todoIntent?: boolean;
}

const MAX_UNITS = 30;

const SOURCE_DIRS = ["src", "lib", "pkg", "app"];
const DOC_DIRS = ["docs", "guides"];
const EXAMPLE_DIRS = ["examples"];
const TEST_DIRS = ["test", "tests"];

const INDEX_FILES = ["index.ts", "index.js", "index.mjs", "index.mts", "mod.ts", "mod.js", "mod.rs", "lib.rs", "main.rs", "main.go", "main.py", "__init__.py"];

// ── Trigger heuristics ─────────────────────────────────────────────

const KNOWN_TRIGGER_PATTERNS: Record<string, string[]> = {
  auth: ["auth", "authentication", "login"],
  route: ["api", "endpoint", "routes"],
  routes: ["api", "endpoint", "routes"],
  router: ["api", "endpoint", "routes"],
  config: ["configuration", "settings"],
  utils: ["utilities", "helpers"],
  util: ["utilities", "helpers"],
  helpers: ["utilities", "helpers"],
  database: ["database", "db", "storage"],
  db: ["database", "db", "storage"],
  middleware: ["middleware", "interceptor"],
  server: ["server", "http", "listen"],
  client: ["client", "http", "request"],
  model: ["model", "schema", "types"],
  models: ["model", "schema", "types"],
  types: ["types", "interfaces", "schema"],
  test: ["test", "testing", "spec"],
  tests: ["test", "testing", "spec"],
  deploy: ["deploy", "deployment", "ci"],
  docker: ["docker", "container", "deployment"],
  cli: ["cli", "commands", "flags"],
  logger: ["logging", "log", "debug"],
  log: ["logging", "log", "debug"],
  cache: ["cache", "caching", "memoize"],
  error: ["error", "errors", "exception"],
  errors: ["error", "errors", "exception"],
  validate: ["validate", "validation", "schema"],
  validation: ["validate", "validation", "schema"],
};

/** Derive triggers from a filename stem. */
function triggersFromFilename(stem: string): string[] {
  const triggers = new Set<string>();
  triggers.add(stem);

  // Kebab/snake → separate words
  const words = stem.split(/[-_]/).filter(Boolean);
  for (const w of words) {
    const lower = w.toLowerCase();
    triggers.add(lower);
    const known = KNOWN_TRIGGER_PATTERNS[lower];
    if (known) known.forEach((t) => triggers.add(t));
  }

  return [...triggers];
}

/** Derive triggers from a directory name. */
function triggersFromDirname(dirname: string): string[] {
  const triggers = new Set<string>();
  triggers.add(dirname);
  const known = KNOWN_TRIGGER_PATTERNS[dirname.toLowerCase()];
  if (known) known.forEach((t) => triggers.add(t));
  return [...triggers];
}

// ── Intent heuristics ──────────────────────────────────────────────

/** Try to extract the first JSDoc/block comment from a source file. */
function extractFirstComment(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath, "utf8");
    // JSDoc-style /** ... */
    const jsdocMatch = content.match(/\/\*\*\s*([\s\S]*?)\*\//);
    if (jsdocMatch) {
      const cleaned = jsdocMatch[1]
        .split("\n")
        .map((l) => l.replace(/^\s*\*\s?/, "").trim())
        .filter(Boolean)
        .join(" ");
      if (cleaned.length > 10 && cleaned.length < 200) return cleaned;
    }
    // Python docstring
    const pyMatch = content.match(/^(?:"""|\'\'\')([\s\S]*?)(?:"""|\'\'\')'/m);
    if (pyMatch) {
      const cleaned = pyMatch[1].trim().split("\n")[0].trim();
      if (cleaned.length > 10 && cleaned.length < 200) return cleaned;
    }
    // Line comment block at file start
    const lines = content.split("\n");
    const commentLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" && commentLines.length === 0) continue;
      if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
        commentLines.push(trimmed.replace(/^\/\/\s?/, "").replace(/^#\s?/, "").trim());
      } else break;
    }
    if (commentLines.length > 0) {
      const first = commentLines[0];
      if (first.length > 10 && first.length < 200 && !first.startsWith("!")) return first;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Extract the first H1 heading from a markdown file. */
function extractH1(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath, "utf8");
    const match = content.match(/^#\s+(.+)/m);
    return match ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

// ── Project metadata detection ─────────────────────────────────────

function detectProjectFromPackageJson(dir: string): DetectedProject | undefined {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return {
      name: pkg.name ?? basename(dir),
      version: pkg.version ?? "0.1.0",
      description: pkg.description,
    };
  } catch {
    return undefined;
  }
}

function detectProjectFromCargoToml(dir: string): DetectedProject | undefined {
  const cargoPath = join(dir, "Cargo.toml");
  if (!existsSync(cargoPath)) return undefined;
  try {
    const content = readFileSync(cargoPath, "utf8");
    const name = content.match(/^name\s*=\s*"(.+)"/m)?.[1];
    const version = content.match(/^version\s*=\s*"(.+)"/m)?.[1];
    return { name: name ?? basename(dir), version: version ?? "0.1.0" };
  } catch {
    return undefined;
  }
}

function detectProjectFromPomXml(dir: string): DetectedProject | undefined {
  const pomPath = join(dir, "pom.xml");
  if (!existsSync(pomPath)) return undefined;
  try {
    const content = readFileSync(pomPath, "utf8");
    const artifactId = content.match(/<artifactId>(.+?)<\/artifactId>/)?.[1];
    const version = content.match(/<version>(.+?)<\/version>/)?.[1];
    return { name: artifactId ?? basename(dir), version: version ?? "0.1.0" };
  } catch {
    return undefined;
  }
}

function detectProjectFromGoMod(dir: string): DetectedProject | undefined {
  const goModPath = join(dir, "go.mod");
  if (!existsSync(goModPath)) return undefined;
  try {
    const content = readFileSync(goModPath, "utf8");
    const mod = content.match(/^module\s+(.+)/m)?.[1]?.trim();
    // Use last path segment as project name
    const name = mod ? mod.split("/").pop()! : basename(dir);
    return { name, version: "0.1.0" };
  } catch {
    return undefined;
  }
}

function detectProject(dir: string): DetectedProject {
  return (
    detectProjectFromPackageJson(dir) ??
    detectProjectFromCargoToml(dir) ??
    detectProjectFromPomXml(dir) ??
    detectProjectFromGoMod(dir) ??
    { name: basename(dir), version: "0.1.0" }
  );
}

// ── Unit scanning ──────────────────────────────────────────────────

/** Make a valid KCP unit id from a filename or directory name. */
function toUnitId(name: string): string {
  return name
    .replace(/\.[^.]+$/, "") // strip extension
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function scanReadme(dir: string, project: string): ScannedUnit | undefined {
  const readmePath = join(dir, "README.md");
  if (!existsSync(readmePath)) return undefined;
  return {
    id: "front-door",
    path: "README.md",
    intent: `What is ${project}, how to install and use it`,
    scope: "global",
    audience: ["agent", "human"],
    triggers: ["overview", "install", "getting started"],
    hints: { load_strategy: "eager" },
  };
}

function scanSourceDir(dir: string, srcDir: string, project: string): ScannedUnit[] {
  const fullPath = join(dir, srcDir);
  if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) return [];

  const units: ScannedUnit[] = [];
  const entries = readdirSync(fullPath);

  for (const entry of entries) {
    const entryPath = join(fullPath, entry);
    const stat = statSync(entryPath);

    if (stat.isDirectory()) {
      // Look for an index file in the subdirectory
      const indexFile = INDEX_FILES.find((f) => existsSync(join(entryPath, f)));
      const unitPath = indexFile
        ? `${srcDir}/${entry}/${indexFile}`
        : `${srcDir}/${entry}`;
      const id = toUnitId(entry);
      if (!id) continue;

      const absPath = indexFile ? join(entryPath, indexFile) : entryPath;
      const comment = indexFile ? extractFirstComment(join(entryPath, indexFile)) : undefined;
      const intent = comment ?? `Implementation of ${entry}`;

      units.push({
        id,
        path: unitPath,
        intent,
        scope: "project",
        audience: ["agent", "developer"],
        triggers: triggersFromDirname(entry),
        todoIntent: !comment,
      });
    } else if (stat.isFile()) {
      const ext = extname(entry);
      if (![".ts", ".js", ".mjs", ".mts", ".py", ".rs", ".go", ".java", ".kt", ".rb", ".cs", ".c", ".cpp", ".h"].includes(ext)) continue;

      const stem = basename(entry, ext);
      // Skip index files at the source root — they're usually just re-exports
      if (INDEX_FILES.includes(entry)) continue;
      const id = toUnitId(stem);
      if (!id) continue;

      const comment = extractFirstComment(entryPath);
      const intent = comment ?? `Implementation of ${stem}`;

      units.push({
        id,
        path: `${srcDir}/${entry}`,
        intent,
        scope: "project",
        audience: ["agent", "developer"],
        triggers: triggersFromFilename(stem),
        todoIntent: !comment,
      });
    }
  }

  return units;
}

function scanDocDir(dir: string, docDir: string): ScannedUnit[] {
  const fullPath = join(dir, docDir);
  if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) return [];

  const units: ScannedUnit[] = [];
  const entries = readdirSync(fullPath);

  for (const entry of entries) {
    const entryPath = join(fullPath, entry);
    if (!statSync(entryPath).isFile()) continue;
    if (extname(entry) !== ".md") continue;

    const stem = basename(entry, ".md");
    const id = toUnitId(`${docDir}-${stem}`);
    if (!id) continue;

    const h1 = extractH1(entryPath);
    const intent = h1 ?? `Documentation: ${stem}`;

    units.push({
      id,
      path: `${docDir}/${entry}`,
      intent,
      scope: "global",
      audience: ["agent", "human"],
      triggers: triggersFromFilename(stem),
      todoIntent: !h1,
    });
  }

  return units;
}

function scanExampleDir(dir: string, exDir: string): ScannedUnit[] {
  const fullPath = join(dir, exDir);
  if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) return [];

  const units: ScannedUnit[] = [];
  const entries = readdirSync(fullPath);

  for (const entry of entries) {
    const entryPath = join(fullPath, entry);
    const stat = statSync(entryPath);

    if (stat.isDirectory()) {
      const id = toUnitId(`example-${entry}`);
      if (!id) continue;
      // Point to a README if one exists, otherwise the directory itself
      const readmePath = join(entryPath, "README.md");
      const path = existsSync(readmePath) ? `${exDir}/${entry}/README.md` : `${exDir}/${entry}`;
      units.push({
        id,
        path,
        intent: `Example: ${entry}`,
        scope: "project",
        audience: ["agent", "developer"],
        triggers: [`example`, entry],
      });
    } else if (stat.isFile()) {
      const ext = extname(entry);
      if (![".ts", ".js", ".py", ".rs", ".go", ".java", ".md", ".sh"].includes(ext)) continue;
      const stem = basename(entry, ext);
      const id = toUnitId(`example-${stem}`);
      if (!id) continue;
      units.push({
        id,
        path: `${exDir}/${entry}`,
        intent: `Example: ${stem}`,
        scope: "project",
        audience: ["agent", "developer"],
        triggers: [`example`, stem],
      });
    }
  }

  return units;
}

function scanTestDir(dir: string, project: string): ScannedUnit | undefined {
  for (const testDir of TEST_DIRS) {
    const fullPath = join(dir, testDir);
    if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) continue;

    // Point to README if it exists, otherwise the first test file
    const readmePath = join(fullPath, "README.md");
    if (existsSync(readmePath)) {
      return {
        id: "test-strategy",
        path: `${testDir}/README.md`,
        intent: `Test strategy and patterns for ${project}`,
        scope: "project",
        audience: ["agent", "developer"],
        triggers: ["test", "testing", "spec"],
      };
    }
    // Find the first test file
    const entries = readdirSync(fullPath);
    const first = entries.find((e) => {
      const s = statSync(join(fullPath, e));
      return s.isFile() && /\.(test|spec)\.(ts|js|py|rs|go|java)$/.test(e);
    });
    if (first) {
      return {
        id: "test-strategy",
        path: `${testDir}/${first}`,
        intent: `Test strategy and patterns for ${project}`,
        scope: "project",
        audience: ["agent", "developer"],
        triggers: ["test", "testing", "spec"],
      };
    }
    // Fallback to any file
    const any = entries.find((e) => statSync(join(fullPath, e)).isFile());
    if (any) {
      return {
        id: "test-strategy",
        path: `${testDir}/${any}`,
        intent: `Test strategy and patterns for ${project}`,
        scope: "project",
        audience: ["agent", "developer"],
        triggers: ["test", "testing", "spec"],
      };
    }
  }
  return undefined;
}

// ── YAML serialization ─────────────────────────────────────────────

/** Escape a YAML string value, using double quotes. */
function yamlStr(value: string): string {
  // If it contains characters that need quoting, use double quotes
  if (/[:#{}[\],&*?|>!'"%@`]/.test(value) || value.includes("\n") || value.trim() !== value) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `"${value}"`;
}

function yamlArray(items: string[]): string {
  return `[${items.map((i) => i).join(", ")}]`;
}

function renderUnit(unit: ScannedUnit): string {
  const lines: string[] = [];
  lines.push(`  - id: ${unit.id}`);
  lines.push(`    path: ${unit.path}`);
  if (unit.todoIntent) {
    lines.push(`    intent: ${yamlStr(unit.intent)}  # TODO: review intent`);
  } else {
    lines.push(`    intent: ${yamlStr(unit.intent)}`);
  }
  lines.push(`    scope: ${unit.scope}`);
  lines.push(`    audience: ${yamlArray(unit.audience)}`);
  lines.push(`    triggers: ${yamlArray(unit.triggers)}`);
  if (unit.hints) {
    const entries = Object.entries(unit.hints).map(([k, v]) => `${k}: ${v}`);
    lines.push(`    hints: {${entries.join(", ")}}`);
  }
  return lines.join("\n");
}

// ── Main entry point ───────────────────────────────────────────────

/**
 * Scan a directory and generate a knowledge.yaml manifest.
 * Returns the YAML string of the generated manifest.
 */
export async function initManifest(dir: string, options: InitOptions = {}): Promise<string> {
  const resolvedDir = dir;

  // 1. Check for existing knowledge.yaml
  const existingPath = join(resolvedDir, "knowledge.yaml");
  if (existsSync(existingPath) && !options.force) {
    throw new Error(`knowledge.yaml already exists in ${resolvedDir} — use --force to overwrite`);
  }

  // 2. Detect project metadata
  const project = detectProject(resolvedDir);

  // 3. Scan for units
  const allUnits: ScannedUnit[] = [];

  // README always first
  const readme = scanReadme(resolvedDir, project.name);
  if (readme) allUnits.push(readme);

  // Source directories
  for (const srcDir of SOURCE_DIRS) {
    allUnits.push(...scanSourceDir(resolvedDir, srcDir, project.name));
  }

  // Doc directories
  for (const docDir of DOC_DIRS) {
    allUnits.push(...scanDocDir(resolvedDir, docDir));
  }

  // Example directories
  for (const exDir of EXAMPLE_DIRS) {
    allUnits.push(...scanExampleDir(resolvedDir, exDir));
  }

  // Test directories
  const testUnit = scanTestDir(resolvedDir, project.name);
  if (testUnit) allUnits.push(testUnit);

  // Deduplicate by id — first occurrence wins
  const seenIds = new Set<string>();
  const deduped: ScannedUnit[] = [];
  for (const unit of allUnits) {
    if (seenIds.has(unit.id)) continue;
    seenIds.add(unit.id);
    deduped.push(unit);
  }

  // Cap at MAX_UNITS — prioritize README, source, docs
  let skippedCount = 0;
  let units: ScannedUnit[];
  if (deduped.length > MAX_UNITS) {
    units = deduped.slice(0, MAX_UNITS);
    skippedCount = deduped.length - MAX_UNITS;
  } else {
    units = deduped;
  }

  // 4. Assemble the manifest YAML
  const today = new Date().toISOString().slice(0, 10);
  const publisherStr = options.publisher
    ? yamlStr(options.publisher)
    : `"Unknown"  # TODO: set your publisher name`;

  const yamlLines: string[] = [];
  yamlLines.push("# Generated by kcp-agent init — review TODOs before publishing");
  yamlLines.push(`kcp_version: "0.25"`);
  yamlLines.push(`project: ${project.name}`);
  yamlLines.push(`version: ${project.version}`);
  yamlLines.push(`updated: "${today}"`);
  yamlLines.push(`language: en`);
  yamlLines.push("");
  yamlLines.push("trust:");
  yamlLines.push("  provenance:");
  yamlLines.push(`    publisher: ${publisherStr}`);
  yamlLines.push("");
  yamlLines.push("payment:");
  yamlLines.push("  default_tier: free");
  yamlLines.push("  methods:");
  yamlLines.push("    - type: free");
  yamlLines.push("");
  yamlLines.push("units:");

  for (const unit of units) {
    yamlLines.push(renderUnit(unit));
    yamlLines.push("");
  }

  if (skippedCount > 0) {
    yamlLines.push(`  # ${skippedCount} additional file(s) found but skipped to keep the manifest manageable.`);
    yamlLines.push(`  # Run kcp-agent init --force to regenerate, or add them manually.`);
    yamlLines.push("");
  }

  const yamlOutput = yamlLines.join("\n");

  // 5. Validate — the generated manifest must pass with zero errors
  const manifest = parseManifest(yamlOutput, existingPath);
  // Validate without baseDir path checks since generated paths reference the
  // target directory — pass the resolved dir so path existence is verified.
  const findings = validateManifest(manifest, resolvedDir);
  const errors = findings.filter((f) => f.level === "error");
  if (errors.length > 0) {
    const msg = errors.map((e) => `  ${e.where}: ${e.message}`).join("\n");
    throw new Error(`Generated manifest has validation errors:\n${msg}`);
  }

  // 6. Write (unless dry-run)
  if (!options.dryRun) {
    writeFileSync(existingPath, yamlOutput, "utf8");
  }

  return yamlOutput;
}
