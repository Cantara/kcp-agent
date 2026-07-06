// Browser stubs for node builtins that reach the bundle only through
// module-level imports (client/follow/verify/validate/synthesize). The site
// calls parseManifest/plan/formatPlan/gateTerms/validateManifest exclusively —
// the I/O paths never execute in the browser; if one ever does, it fails
// loudly. isAbsolute is the one real implementation: validateManifest's unit-
// path linting runs live in the playground.

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
export const isAbsolute = (p) => String(p).startsWith("/") || /^[A-Za-z]:[\\/]/.test(String(p));

// node:crypto — the browser has WebCrypto natively
export const webcrypto = globalThis.crypto;
// createHash is only reached via planTree/loadPlannedUnits (I/O paths the site never calls)
export const createHash = die("crypto.createHash");

// node:readline (mcp.ts — never bundled, but keep the stub total)
export const createInterface = die("readline.createInterface");

// node:dns/promises + node:net (fetch.ts — reached only on remote I/O paths the
// site never calls; isIP is a real impl so the guard's type checks stay honest)
export const lookup = die("dns.lookup");
export const isIP = (s) => {
  const str = String(s);
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(str)) return 4;
  if (str.includes(":")) return 6;
  return 0;
};
