// Serving Endpoint Binding — KCP §3.12 (v0.26, RFC-0024).
//
// A signed manifest may declare the exhaustive list of URLs it is
// authoritatively served from (`serving.manifest`) and the MCP endpoints
// authorized to represent it (`serving.mcp`). A verified signature proves the
// bytes are the publisher's; it says nothing about *where* they were obtained.
// Without the binding, anyone can re-host a validly signed manifest and become
// an unauthorized "representative" of it (threat T11).
//
// The check here is §16.5 C22: when a manifest was retrieved over HTTP(S) and
// declares serving.manifest, but the final post-redirect retrieval URL is not
// in that list, the render/plan must not tier above `known` and must emit a
// warning naming both the retrieval URL and the declared list.
//
// URL matching (§3.12): compare the final post-redirect URL for manifest
// retrieval (the dialed URL for MCP); lowercase scheme and host, strip a
// default port, strip query and fragment, exact path match — no wildcards.

import type { Serving } from "./model.js";

export type ServingStatus = "bound" | "unbound" | "no-binding" | "local";

export interface ServingCheck {
  status: ServingStatus;
  detail: string;
  /** Final post-redirect URL the manifest was retrieved from (http(s) sources only). */
  retrievalUrl?: string;
  /** The declared serving.manifest list, as published. */
  declared?: string[];
}

/**
 * Normalize a URL for §3.12 comparison: lowercase scheme/host, strip the
 * scheme's default port, strip query and fragment, keep the exact path.
 * Returns undefined for anything that does not parse as an http(s) URL.
 */
export function normalizeServingUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : "";
  // URL already lowercases protocol and hostname and drops a default port,
  // but be explicit so the rule survives a different URL implementation.
  return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port}${url.pathname}`;
}

/**
 * §16.5 C22 — check the manifest's retrieval URL against its declared
 * serving.manifest list. Pure: both inputs come from the loaded manifest
 * (`source` is the final post-redirect URL, set by the loading layer).
 * Returns undefined when the manifest declares no serving block at all —
 * there is nothing to check and nothing to report.
 */
export function checkServing(serving: Serving | undefined, source: string | undefined): ServingCheck | undefined {
  if (!serving) return undefined;
  const declared = serving.manifest ?? [];
  if (declared.length === 0) {
    return { status: "no-binding", detail: "serving block declares no manifest URLs — retrieval binding not in effect" };
  }
  if (!source || !/^https?:\/\//i.test(source)) {
    return {
      status: "local",
      detail: "loaded from a local path — retrieval binding applies to HTTP(S) retrieval only",
      declared,
    };
  }
  const normalizedSource = normalizeServingUrl(source);
  const match = normalizedSource !== undefined && declared.some((d) => normalizeServingUrl(d) === normalizedSource);
  if (match) {
    return { status: "bound", detail: `retrieval URL is in the declared serving.manifest list`, retrievalUrl: source, declared };
  }
  return {
    status: "unbound",
    detail:
      `retrieved from ${source}, which is not in the declared serving.manifest list ` +
      `[${declared.join(", ")}] — trust capped at 'known' (KCP §16.5 C22)`,
    retrievalUrl: source,
    declared,
  };
}

/** RFC 8288 Link header values for a served manifest (issue #88 / jasswiki pattern). */
export interface ServingLinks {
  /** `Link` header values, e.g. `<url>; rel="knowledge-manifest"`. */
  links: string[];
  /** Startup self-check warning when the server's public URL is not in serving.mcp. */
  warning?: string;
}

/**
 * Build the Link header values a serving MCP endpoint should attach to
 * `/mcp` and `/health` responses, plus the Level-2 self-check against the
 * manifest's declared serving.mcp list.
 *
 * `manifestUrl` is where the manifest is publicly retrievable (the served
 * location, or the first declared serving.manifest entry). `signatureUrl` and
 * `keyUrl` are included only when they resolve to absolute http(s) URLs —
 * inline key material cannot be linked.
 */
export function buildServingLinks(args: {
  manifestUrl?: string;
  signatureUrl?: string;
  keyUrl?: string;
  servingMcp?: string[];
  publicUrl?: string;
}): ServingLinks {
  const links: string[] = [];
  if (args.manifestUrl) links.push(`<${args.manifestUrl}>; rel="knowledge-manifest"`);
  if (args.signatureUrl) links.push(`<${args.signatureUrl}>; rel="knowledge-manifest-signature"`);
  if (args.keyUrl) links.push(`<${args.keyUrl}>; rel="signing-key"`);

  let warning: string | undefined;
  const mcp = args.servingMcp ?? [];
  if (mcp.length > 0) {
    if (!args.publicUrl) {
      warning =
        `manifest declares serving.mcp [${mcp.join(", ")}] but no --public-url was given — ` +
        `cannot self-check that this endpoint is an authorized representative`;
    } else {
      const normalized = normalizeServingUrl(args.publicUrl);
      const ok = normalized !== undefined && mcp.some((m) => normalizeServingUrl(m) === normalized);
      if (!ok) {
        warning =
          `public URL ${args.publicUrl} is not in the manifest's declared serving.mcp list ` +
          `[${mcp.join(", ")}] — agents applying KCP §3.12 will not treat this endpoint as authorized`;
      }
    }
  }
  return { links, warning };
}
