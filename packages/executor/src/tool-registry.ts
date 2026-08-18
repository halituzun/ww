import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { ExecutorError } from './errors.js';

export const TOOL_NAMES = [
  'read_file',
  // docs/05'te tanımlıydı ama hiç yazılmamıştı: worker hangi dosyaların var
  // olduğunu göremiyor, canlı koşuda "Workspace'te hangi dosyalar mevcut?"
  // diye sorup duruyordu.
  'list_dir',
  'search_code',
  'create_subtask',
  'memory_query',
  'write_file',
  'edit_file',
  'run_command',
  'git_diff',
  'ask_question',
  'report_result',
  'submit_verdict',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
export type ToolSchema = Readonly<Record<string, unknown>>;

export interface ExecutorToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  /** This is the exact object compiled by Ajv, not a translated copy. */
  readonly parameters: ToolSchema;
}

interface RegistryEntry {
  readonly definition: ExecutorToolDefinition;
  readonly validate: ValidateFunction;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseSchema(name: ToolName): ToolSchema {
  const location = fileURLToPath(new URL(`../tools/${name}.json`, import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(location, 'utf8'));
  if (!isObject(parsed) || parsed['type'] !== 'object' || parsed['additionalProperties'] !== false) {
    throw new Error(`Executor tool schema kapalı bir object olmalıdır: ${name}`);
  }
  return deepFreeze(parsed);
}

function formatAjvErrors(errors: readonly ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) return 'bilinmeyen şema hatası';
  return errors
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'geçersiz'}`)
    .join('; ');
}

export class ToolRegistry {
  static readonly instance = new ToolRegistry();

  readonly #entries: ReadonlyMap<ToolName, RegistryEntry>;

  private constructor() {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const entries = new Map<ToolName, RegistryEntry>();
    for (const name of TOOL_NAMES) {
      const schema = parseSchema(name);
      if (!ajv.validateSchema(schema)) {
        throw new Error(`Geçersiz executor tool schema ${name}: ${formatAjvErrors(ajv.errors)}`);
      }
      const description = typeof schema['description'] === 'string'
        ? schema['description']
        : name;
      entries.set(name, Object.freeze({
        definition: Object.freeze({ name, description, parameters: schema }),
        validate: ajv.compile(schema),
      }));
    }
    this.#entries = entries;
  }

  has(name: string): name is ToolName {
    return this.#entries.has(name as ToolName);
  }

  definition(name: ToolName): ExecutorToolDefinition {
    return this.#entry(name).definition;
  }

  definitions(names: readonly ToolName[] = TOOL_NAMES): readonly ExecutorToolDefinition[] {
    return Object.freeze(names.map((name) => this.definition(name)));
  }

  parseArguments(name: ToolName, value: unknown): Readonly<Record<string, unknown>> {
    const validator = this.#entry(name).validate;
    if (!validator(value) || !isObject(value)) {
      throw new ExecutorError(
        'INVALID_ARGUMENTS',
        `${name} argümanları geçersiz: ${formatAjvErrors(validator.errors)}`,
      );
    }
    return value;
  }

  validator(name: ToolName): ValidateFunction {
    return this.#entry(name).validate;
  }

  #entry(name: ToolName): RegistryEntry {
    const entry = this.#entries.get(name);
    if (entry === undefined) throw new ExecutorError('INVALID_TOOL', `Bilinmeyen tool: ${name}`);
    return entry;
  }
}

/** Process-wide singleton: JSON is loaded and Ajv validators are compiled once. */
export const executorToolRegistry = ToolRegistry.instance;
