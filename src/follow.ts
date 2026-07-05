// Federation following — the async orchestration around the pure planner.
//
// The planner *decides* which federation refs are eligible; this module
// actually fetches them, recursively, fail-closed: refs excluded by context,
// refs needing a credential the agent doesn't hold, cycles, and hops beyond
// the depth limit are never fetched — they're reported with the reason. Each
// fetched manifest passes through signature verification before it is planned;
// an invalid signature poisons that node (and its subtree), never the parent.

import { loadManifestText, parseManifest } from "./client.js";
import { plan, type PlanOptions, type AgentPlan } from "./planner.js";
import { verifyManifestText, resolveLocation, type SignatureResult, type VerifyOptions } from "./verify.js";
import { resolve as resolvePath, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

export interface FollowOptions {
  planOptions?: PlanOptions;
  /** Federation hops beyond the root manifest (0 = don't follow). */
  maxDepth?: number;
  /** Skip signature verification entirely. */
  noVerify?: boolean;
  /** Fail-closed unless every fetched manifest has a *verified* signature. */
  requireSignature?: boolean;
  /** Pinned public key (path/URL/inline) for verification. */
  trustedKey?: string;
}

export interface NotFollowedRef {
  id: string;
  url: string;
  reason: string;
}

export interface PlanNode {
  /** Federation ref id that led here; undefined at the root. */
  refId?: string;
  location: string;
  plan?: AgentPlan;
  signature?: SignatureResult;
  /** Fetch/parse/signature failure — the node is dead, fail-closed. */
  error?: string;
  notFollowed: NotFollowedRef[];
  children: PlanNode[];
}

function normalize(location: string): string {
  return /^https?:\/\//.test(location) || isAbsolute(location) ? location : resolvePath(location);
}

/** Plan a manifest and, up to maxDepth hops, its eligible federation. */
export async function planTree(location: string, task: string, options: FollowOptions = {}): Promise<PlanNode> {
  const maxDepth = options.maxDepth ?? 0;
  const visited = new Set<string>();
  const baseBudget = options.planOptions?.budget;
  // Tree-wide budget ledger: spend committed by earlier nodes counts against
  // every later node's ceiling — one --budget is one ceiling, not one per hop.
  let committed = baseBudget?.spent ?? 0;
  const round6 = (n: number): number => Number(n.toFixed(6));

  async function visit(loc: string, refId: string | undefined, depth: number): Promise<PlanNode> {
    const node: PlanNode = { refId, location: loc, notFollowed: [], children: [] };
    let text: string;
    let source: string;
    try {
      ({ text, source } = await loadManifestText(loc));
    } catch (e) {
      node.error = `fetch failed: ${e instanceof Error ? e.message : String(e)}`;
      return node;
    }
    node.location = source;
    visited.add(normalize(source));

    let manifest;
    try {
      manifest = parseManifest(text, source);
    } catch (e) {
      node.error = `parse failed: ${e instanceof Error ? e.message : String(e)}`;
      return node;
    }

    if (!options.noVerify) {
      const verifyOpts: VerifyOptions = { trustedKey: options.trustedKey };
      node.signature = await verifyManifestText(text, manifest.signing, source, verifyOpts);
      if (node.signature.status === "invalid") {
        node.error = `signature invalid: ${node.signature.detail}`;
        return node;
      }
      if (options.requireSignature && node.signature.status !== "verified") {
        node.error = `signature required but ${node.signature.status}: ${node.signature.detail}`;
        return node;
      }
    }

    const planOptions: PlanOptions | undefined = baseBudget
      ? { ...options.planOptions, budget: { ...baseBudget, ...(committed > 0 ? { spent: round6(committed) } : {}) } }
      : options.planOptions;
    const p = plan(manifest, task, planOptions);
    if (baseBudget) committed = round6(committed + (p.budget.projectedSpend ?? 0));
    p.manifest.sha256 = createHash("sha256").update(text, "utf8").digest("hex");
    p.signature = node.signature;
    node.plan = p;

    for (const ref of p.federation) {
      if (!ref.selected) {
        node.notFollowed.push({ id: ref.id, url: ref.url, reason: ref.reason });
        continue;
      }
      if (ref.credentialNeeded) {
        node.notFollowed.push({ id: ref.id, url: ref.url, reason: `needs ${ref.credentialNeeded} before fetch` });
        continue;
      }
      if (depth >= maxDepth) {
        node.notFollowed.push({ id: ref.id, url: ref.url, reason: `beyond max depth ${maxDepth}` });
        continue;
      }
      const childLoc = resolveLocation(source, ref.url);
      if (visited.has(normalize(childLoc))) {
        node.notFollowed.push({ id: ref.id, url: ref.url, reason: "already visited (cycle)" });
        continue;
      }
      node.children.push(await visit(childLoc, ref.id, depth + 1));
    }
    return node;
  }

  return visit(location, undefined, 0);
}

/** All successfully planned nodes in the tree, root first, depth-first. */
export function plans(node: PlanNode): AgentPlan[] {
  const out: AgentPlan[] = [];
  if (node.plan) out.push(node.plan);
  for (const child of node.children) out.push(...plans(child));
  return out;
}
