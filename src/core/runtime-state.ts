import type { RedQueenConfig } from "./config.js";
import type { PhaseGraph } from "./types.js";

export class RuntimeState {
  constructor(
    public phaseGraph: PhaseGraph,
    public config: RedQueenConfig,
  ) {}
}
