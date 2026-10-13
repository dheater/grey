import * as fs from "fs";
import * as path from "path";
import { once } from "events";
import { spawn } from "child_process";

export const HINT =
  "# Above: your message. :wq sends. Empty, :q or :cq ends grey. " +
  "Lines start :plan, :review, :model <name>, :effort <level> come first.";

export const SCISSORS =
  "# ------------------------ >8 ------------------------";

export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (
        char === "\\" &&
        i + 1 < command.length &&
        command[i + 1] === quote
      ) {
        current += command[++i];
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      current += command[++i];
      continue;
    }
    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

export function parseTurnFile(text: string): string {
  const lines = text.split("\n");
  const cut = lines.indexOf(SCISSORS);
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n").trim();
}

export interface TurnParts {
  draft: string;
  reply: string;
  status: string;
}

export function buildTurnFile({ draft, reply, status }: TurnParts): string {
  return [draft, "", SCISSORS, HINT, "", reply, "", status, ""].join("\n");
}

export async function editTurn(
  file: string,
  parts: TurnParts,
): Promise<string | null> {
  if (!isInteractive()) {
    throw new Error(
      `No terminal, so grey cannot open an editor for your message.\n` +
        `Run grey from an interactive terminal, not from a pipe, script, or CI job`,
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildTurnFile(parts), "utf-8");

  const editorCommand = getEditorCommand();
  const [editor, ...args] = splitCommand(editorCommand);
  const child = spawn(editor || "vi", [...args, file], { stdio: "inherit" });
  const exited = once(child, "exit").catch((err: Error) => {
    throw new Error(
      `Failed to open editor '${editorCommand}': ${err.message}\n` +
        `set EDITOR to an editor on your path, for example: export EDITOR=vi`,
    );
  });

  const [code] = (await exited) as [number | null];
  if (code !== 0) return null;

  const message = parseTurnFile(fs.readFileSync(file, "utf-8"));
  return message === "" || message === ":q" ? null : message;
}

/**
 * Whether a terminal editor has a terminal to take over.
 *
 * A backgrounded, piped, or CI run has no tty, and `vi` handed a dead stdin does
 * not fail — it waits. A `carl feedback` run in a script sat on an invisible nvim
 * for twenty minutes before anyone noticed, so every editor call checks first.
 */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function getEditorCommand(): string {
  return process.env.EDITOR || process.env.VISUAL || "vi";
}
