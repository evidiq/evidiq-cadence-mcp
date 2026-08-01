export function jcs(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("JCS: non-finite numbers are not allowed");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "bigint":
    case "undefined":
    case "function":
    case "symbol":
      throw new Error("JCS: unsupported value type");
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map(jcs).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(obj[k])}`).join(",")}}`;
}
