export interface TaskRowLike {
  readonly project_id?: string;
  readonly title: string;
  readonly description: string;
  readonly acceptance_criteria: readonly string[];
}
