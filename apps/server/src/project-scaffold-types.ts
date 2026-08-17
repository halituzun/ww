export interface GateStepLike {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutSec?: number;
}

export interface GateConfigLike {
  readonly version: 1;
  readonly inputs: readonly string[];
  readonly discardedOutputs: readonly string[];
  readonly steps: readonly GateStepLike[];
}
