import { runWorkerLoop, type WorkerLoopInput, type WorkerLoopResult } from './worker-loop.js';
import { runVerifierLoop, type VerifierInput, type VerifierResult } from './verifier-loop.js';
import { runPmLoop, type PmLoopInput } from './pm-loop.js';
import { SealedPromptLoader, type PromptLoader } from './prompt-loader.js';

export interface AgentRuntime { worker(input: Omit<WorkerLoopInput, 'prompt'>): Promise<WorkerLoopResult>; verifier(input: Omit<VerifierInput, 'prompt'>): Promise<VerifierResult>; pm(input: Omit<PmLoopInput, 'prompt'>): Promise<string>; }
export function createAgentRuntime(input: Readonly<{ promptLoader?: PromptLoader }>): AgentRuntime {
  const loader = input.promptLoader ?? new SealedPromptLoader();
  return {
    worker: (value) => runWorkerLoop({ ...value, prompt: loader.loadWorker({ brief: value.brief, snapshot: value.snapshot, tools: value.tools.definitions() }) }),
    verifier: (value) => runVerifierLoop({ ...value, prompt: loader.loadVerifier({ brief: value.brief, snapshot: value.snapshot, diff: value.diff, summary: value.summary }) }),
    pm: (value) => runPmLoop({ ...value, ...(value.command === undefined ? {} : { command: value.command }), ...(value.question === undefined ? {} : { question: value.question }), prompt: loader.loadPm({ snapshot: value.snapshot, ...(value.command === undefined ? {} : { command: value.command }), ...(value.question === undefined ? {} : { question: value.question }) }) }),
  };
}
