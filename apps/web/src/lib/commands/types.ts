export type ArgumentType = "project" | "task" | "spark" | "text";

export interface CommandArgument {
  id: string;
  type: ArgumentType;
  placeholder?: string;
  /** Label to show on the completed badge (e.g. "Project: Isagi") */
  labelPrefix?: string;
}

export interface CommandDef {
  id: string;
  label: string;
  aliases?: string[];
  arguments: CommandArgument[];
}
