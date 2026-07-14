export const PLAN_JSON_SCHEMA_VERSION = 1 as const;

export type PlanJsonKind = "plan" | "tree" | "trace";

export function versionPlanJson(value: unknown, kind: PlanJsonKind): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("plan JSON artifact must be an object");
  }
  return {
    ...(value as Record<string, unknown>),
    schemaVersion: PLAN_JSON_SCHEMA_VERSION,
    kind,
  };
}

export function encodePlanJson(value: unknown, kind: PlanJsonKind): string {
  return JSON.stringify(versionPlanJson(value, kind), null, 2);
}
