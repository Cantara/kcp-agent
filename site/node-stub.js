// Browser stubs for node builtins that reach the bundle only through
// module-level imports (client/follow/verify/synthesize). The arena calls
// parseManifest/plan/formatPlan/gateTerms exclusively — none of these paths
// execute in the browser; if one ever does, it fails loudly.

const die = (name) => () => {
  throw new Error(`node:${name} is not available in the browser bundle`);
};

// node:fs
export const readFileSync = die("fs.readFileSync");
export const statSync = die("fs.statSync");
export const existsSync = () => false;

// node:path
export const join = die("path.join");
export const dirname = die("path.dirname");
export const resolve = die("path.resolve");
export const isAbsolute = die("path.isAbsolute");

// node:crypto — the browser has WebCrypto natively
export const webcrypto = globalThis.crypto;

// node:readline (mcp.ts — never bundled, but keep the stub total)
export const createInterface = die("readline.createInterface");
