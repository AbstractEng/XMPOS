// Trusted local example definitions shared by the Studio, worklet and offline CLI.
import { machines } from "../../packages/core/src/machines.ts";
import { pulseMachine } from "./pulse.ts";
import { transposeMachine } from "./transpose.ts";

for (const definition of [pulseMachine, transposeMachine])
  if (!machines.list().some((d) => d.id === definition.id)) machines.register(definition);
