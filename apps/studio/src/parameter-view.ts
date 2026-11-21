import type { Project } from "@xmp/core";
import { parameterValue } from "../../../packages/core/src/edits.ts";

export function parameterDisplay(project: Project, id: string) {
  const value = parameterValue(project, id);
  return { value, text: `${(value * 100).toFixed(1)}%` };
}
