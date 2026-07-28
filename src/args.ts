// Argument parsing and help text, extracted from cli.ts.
//
// These two lived beside each other in cli.ts and drifted apart anyway: five flags were
// advertised in USAGE with no matching `case` in the parser, so `init --dry-run` and
// `watch --once` exited with "Unknown option" while the features behind them worked.
// They are here together so a test can import them without importing cli.ts, which runs
// main() on load.
//
// parseArgs throws rather than calling process.exit so the failure is observable; cli.ts
// turns UnknownOptionError back into the same stderr message and exit code 2.

/** Thrown for an unrecognised `--flag`. cli.ts renders this as exit code 2. */
export class UnknownOptionError extends Error {
  constructor(public readonly option: string) {
    super(`Unknown option: ${option}`);
    this.name = "UnknownOptionError";
  }
}

export interface Args {
  command: string;
  task?: string;
  manifest?: string;
  env?: string;
  asOf?: string;
  maxUnits?: number;
  strict: boolean;
  role?: string;
  methods?: string[];
  credentials?: string[];
  attest?: string;
  budget?: number;
  currency?: string;
  contextBudget?: number;
  follow: boolean;
  maxDepth?: number;
  maxNodes?: number;
  allowPrivateHosts: boolean;
  noVerify: boolean;
  requireSignature: boolean;
  trustKey?: string;
  json: boolean;
  model?: string;
  loop: boolean;
  maxRounds?: number;
  loopModel?: string;
  ground: boolean;
  groundModel?: string;
  groundRounds?: number;
  checkGaps: boolean;
  memory?: string;
  replay: boolean;
  limit?: number;
  trace: boolean;
  baseUrl?: string;
  apiKey?: string;
  publicUrl?: string;
  help: boolean;
  // Previously read straight off process.argv by their handlers, which is why the
  // parser rejecting them went unnoticed — the handler code looked correct.
  once: boolean;
  diff: boolean;
  dryRun: boolean;
  force: boolean;
  publisher?: string;
  /** Opaque caller-supplied id echoed into the --json envelope. Not validated: kcp-agent
   *  is not the authority on the caller's tracing format. */
  correlationId?: string;
  /** Convert an existing llms.txt (URL or path) into a draft manifest. */
  fromLlmsTxt?: string;
  positionals: string[];
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { command: argv[0] ?? "", strict: false, json: false, follow: false, allowPrivateHosts: false, noVerify: false, requireSignature: false, loop: false, ground: false, checkGaps: false, replay: false, trace: false, help: false, once: false, diff: false, dryRun: false, force: false, positionals: [] };
  const rest = argv.slice(1);
  const positionals: string[] = [];
  let explicitTask = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    const next = () => rest[++i];
    switch (t) {
      case "--manifest": a.manifest = next(); break;
      case "--env": a.env = next(); break;
      case "--as-of": a.asOf = next(); break;
      case "--max-units": a.maxUnits = Number(next()); break;
      case "--strict": a.strict = true; break;
      case "--role": a.role = next(); break;
      case "--methods": a.methods = (next() ?? "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--credentials": a.credentials = (next() ?? "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--attest": a.attest = next(); break;
      case "--budget": a.budget = Number(next()); break;
      case "--context-budget": a.contextBudget = Number(next()); break;
      case "--currency": a.currency = next(); break;
      case "--follow": a.follow = true; break;
      case "--max-depth": a.maxDepth = Number(next()); a.follow = true; break;
      case "--max-nodes": a.maxNodes = Number(next()); break;
      case "--allow-private-hosts": a.allowPrivateHosts = true; break;
      case "--no-verify": a.noVerify = true; break;
      case "--require-signature": a.requireSignature = true; break;
      case "--trust-key": a.trustKey = next(); break;
      case "--model": a.model = next(); break;
      case "--loop": a.loop = true; break;
      case "--max-rounds": a.maxRounds = Number(next()); break;
      case "--loop-model": a.loopModel = next(); break;
      case "--ground": a.ground = true; break;
      case "--ground-model": a.groundModel = next(); break;
      case "--ground-rounds": a.groundRounds = Number(next()); a.ground = true; break;
      case "--check-gaps": a.checkGaps = true; break;
      case "--json": a.json = true; break;
      case "--memory": a.memory = next(); break;
      case "--replay": a.replay = true; break;
      case "--limit": a.limit = Number(next()); break;
      case "--trace": a.trace = true; break;
      case "--base-url": a.baseUrl = next(); break;
      case "--api-key": a.apiKey = next(); break;
      case "--public-url": a.publicUrl = next(); break;
      case "--once": a.once = true; break;
      case "--diff": a.diff = true; break;
      case "--dry-run": a.dryRun = true; break;
      case "--force": a.force = true; break;
      case "--publisher": a.publisher = next(); break;
      case "--correlation-id": a.correlationId = next(); break;
      case "--from-llms-txt": a.fromLlmsTxt = next(); break;
      // `watch --task "<task>"` is documented; without a case it was rejected, and
      // the only way to pass a task was positionally.
      case "--task": a.task = next(); explicitTask = true; break;
      case "--help": case "-h": a.help = true; break;
      default:
        if (t.startsWith("--")) throw new UnknownOptionError(t);
        positionals.push(t);
    }
  }
  a.positionals = positionals;
  if (!explicitTask) a.task = positionals.join(" ") || undefined;
  return a;
}

export const USAGE =
  'Usage:\n' +
  '  kcp-agent plan     "<task>" --manifest <path|dir|url> [options]\n' +
  '  kcp-agent ask      "<task>" --manifest <path|dir|url> [options]\n' +
  '  kcp-agent validate <path|dir|url> [--json]\n' +
  '  kcp-agent replay   <plan.json> [--json]\n' +
  '  kcp-agent remember <artifact.json> --memory <dir>\n' +
  '  kcp-agent recall   "<task>" --memory <dir> [--replay] [--limit <n>]\n' +
  '  kcp-agent diff     <a.json> <b.json> [--json]\n' +
  '  kcp-agent mcp\n' +
  '  kcp-agent serve    [<port>] [--api-key <key>] [--manifest <path|dir|url>] [--public-url <url>]\n' +
  '  kcp-agent watch    <path|dir> [--task "<task>"] [--diff] [--once] [--json]\n' +
  '  kcp-agent init     [dir] [--publisher <name>] [--from-llms-txt <url|path>] [--dry-run] [--force]\n' +
  '  kcp-agent discover <url>\n' +
  "\nRun `kcp-agent plan --help` for options.";

export const OPTIONS =
  'Options:\n' +
  '  --manifest <loc>        manifest path, directory, or URL\n' +
  '  --env <env>             environment for scope filtering\n' +
  '  --as-of <date>          plan as of a pinned date (default: today)\n' +
  '  --max-units <n>         cap on selected units (default 5)\n' +
  '  --strict                fail-closed: drop non-eligible units instead of listing them\n' +
  '  --role <role>           audience role the agent presents (default: agent)\n' +
  '  --methods <list>        payment methods the agent can settle, e.g. free,x402\n' +
  '  --credentials <list>    credential kinds the agent holds, e.g. api_key,oauth2\n' +
  '  --attest <provider>     attestation provider the agent can present\n' +
  '  --budget <amount>       spend ceiling for pay-per-request units (whole federated walk)\n' +
  '  --currency <code>       budget currency (default USDC)\n' +
  '  --context-budget <n>    token ceiling for loaded context (composes with --budget)\n' +
  '  --follow                fetch and plan eligible federation refs too\n' +
  '  --max-depth <n>         federation hops to follow (default 1; implies --follow)\n' +
  '  --max-nodes <n>         cap on total manifests fetched across the walk (default 64)\n' +
  '  --allow-private-hosts   permit loopback/private hosts and http:// (off by default)\n' +
  '  --no-verify             skip manifest signature verification\n' +
  '  --require-signature     fail unless every manifest has a verified signature\n' +
  '  --trust-key <loc>       pinned ed25519 public key for verification\n' +
  '  --trace                 (plan) show the per-unit gate-cascade decision trace\n' +
  '  --json                  emit the result as JSON (stable, versioned: schemaVersion + kind)\n' +
  '  --model <id>            (ask) synthesis model id, e.g. anthropic/claude-opus-4-8\n' +
  '  --base-url <url>        (ask) base URL for OpenAI-compatible endpoints\n' +
  '  --api-key <key>         (ask) API key — alternative to ANTHROPIC_API_KEY / OPENAI_API_KEY\n' +
  '  --loop                  (ask) audited critique loop: plan → critique → term gate → re-plan\n' +
  '  --max-rounds <n>        (ask --loop) max critique rounds (default 3)\n' +
  '  --loop-model <id>       (ask --loop) critic model\n' +
  '  --ground                (ask) verify each answer claim against a loaded unit\n' +
  '  --ground-model <id>     (ask --ground) verifier model\n' +
  '  --ground-rounds <n>     (ask) closed-loop grounding rounds (default 0)\n' +
  '  --check-gaps            (replay) re-navigate to see if a surfaced gap now closes\n' +
  '  --memory <dir>          (remember/recall/plan) episodic-memory directory\n' +
  '  --replay                (recall) re-verify each hit against the live world\n' +
  '  --limit <n>             (recall) max hits returned\n' +
  '  --public-url <url>      (serve) advertised public base URL\n' +
  '  --correlation-id <id>   opaque caller id echoed into the --json envelope (for audit joins)\n' +
  '  --from-llms-txt <loc>   (init) draft a manifest from an existing llms.txt (URL or path)';
