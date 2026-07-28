export const PLAN_JSON_SCHEMA_VERSION = 1 as const;

export type PlanJsonKind = "plan" | "tree" | "trace";

export function versionPlanJson(
  value: unknown,
  kind: PlanJsonKind,
  correlationId?: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("plan JSON artifact must be an object");
  }
  return {
    ...(value as Record<string, unknown>),
    schemaVersion: PLAN_JSON_SCHEMA_VERSION,
    kind,
    // Spread last and only when present, so an artifact produced without the flag is
    // byte-identical to what earlier versions emitted — otherwise every stored plan
    // changes shape at once — and an explicit id beats a colliding field on the body.
    ...(correlationId ? { correlationId } : {}),
  };
}

export function encodePlanJson(value: unknown, kind: PlanJsonKind, correlationId?: string): string {
  return JSON.stringify(versionPlanJson(value, kind, correlationId), null, 2);
}
