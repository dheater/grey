import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildTurnFile,
  editTurn,
  parseTurnFile,
  splitCommand,
  HINT,
  SCISSORS,
} from "./editor";

describe("splitCommand", () => {
  test.each<[string, string[]]>([
    ["vi", ["vi"]],
    ["code --wait", ["code", "--wait"]],
    ["nvim   +1", ["nvim", "+1"]],
    ['"/Applications/My Editor/ed" -w', ["/Applications/My Editor/ed", "-w"]],
    ["'my editor' -f", ["my editor", "-f"]],
    ["my\\ editor", ["my editor"]],
    ['"say \\"hi\\""', ['say "hi"']],
    ["", []],
  ])("%j splits into %j", (command, parts) => {
    expect(splitCommand(command)).toEqual(parts);
  });
});

describe("parseTurnFile", () => {
  test("keeps markdown headings above the scissors line", () => {
    expect(
      parseTurnFile(`# Plan\n\n## Step one\nbody\n${SCISSORS}\nreply`),
    ).toBe("# Plan\n\n## Step one\nbody");
  });

  test("drops everything from the first scissors line done", () => {
    expect(parseTurnFile(`ask\n${SCISSORS}\nreply`)).toBe(`ask`);
  });

  test("cuts only at a line qual to SCISSORS", () => {
    expect(parseTurnFile(`see ${SCISSORS}\n${SCISSORS}\nreply`)).toBe(
      `see ${SCISSORS}`,
    );
  });

  test("with no scissors line the whole text is in the message", () => {
    expect(parseTurnFile("  just this \n")).toBe("just this");
  });
});

describe("buildTurnFile", () => {
  test("lays out draft, scissors, hint, reply, and status in order", () => {
    const status = "[sonnet5.5 default - turn 1]";
    expect(
      buildTurnFile({ draft: "my question", reply: "the answer", status }),
    ).toBe(
      [
        "my question",
        "",
        SCISSORS,
        HINT,
        "",
        "the answer",
        "",
        status,
        "",
      ].join("\n"),
    );
  });

  test("a fresh turn opens on an empty first line", () => {
    expect(buildTurnFile({ draft: "", reply: "", status: "[s]" })).toMatch(
      new RegExp(`^\\n\\n${SCISSORS}\\n`),
    );
  });

  test("parseTurnFile returns the draft unchanged", () => {
    const draft = ":plan\n# Heading\nbody line";
    const reply = `reply\n${SCISSORS}\nmore`;
    expect(parseTurnFile(buildTurnFile({ draft, reply, status: "[s]" }))).toBe(
      draft,
    );
  });
});

// node returns `undefined` for a pipe
function setTty(stdin: boolean, stdout: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value: stdin || undefined,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: stdout || undefined,
    configurable: true,
  });
}

describe("editTurn", () => {
  const stdinTty = process.stdin.isTTY;
  const stdoutTty = process.stdout.isTTY;
  const editorEnv = process.env.EDITOR;
  const parts = { draft: "", reply: "last reply", status: "[s]" };
  let dir: string;
  let file: string;

  // An "editor" that saves `text` as the turn file, as `:wq` would.
  function editorWriting(text: string): string {
    const next = path.join(dir, "next.md");
    fs.writeFileSync(next, text);
    return `cp '${next}'`;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grey-edtitor-"));
    file = path.join(dir, "grey", "turn.md");
    setTty(true, true);
  });

  afterEach(() => {
    setTty(Boolean(stdinTty), Boolean(stdoutTty));
    if (editorEnv === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = editorEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("without a terminal it throws and writes nothing", async () => {
    setTty(false, true);
    process.env.EDITOR = "true";
    await expect(editTurn(file, parts)).rejects.toThrow(
      // No terminal, so grey cannot open an editor,
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  test("writes the turn file, creating its directory", async () => {
    process.env.EDITOR = "true";
    await editTurn(file, { ...parts, draft: "kept" });
    expect(fs.readFileSync(file, "utf-8")).toBe(
      buildTurnFile({ ...parts, draft: "kept" }),
    );
  });

  test("returns the message the editor saved above the scissors line", async () => {
    process.env.EDITOR = editorWriting(`# Question\nwhy?\n${SCISSORS}\nold`);
    await expect(editTurn(file, parts)).resolves.toBe("# Question\nwhy?");
  });

  test("an unchanged draft is send again", async () => {
    process.env.EDITOR = "true";
    await expect(editTurn(file, { ...parts, draft: "kept" })).resolves.toBe(
      "kept",
    );
  });

  test("a non-zero exit, as from :cq, returns null even with a draft", async () => {
    process.env.EDITOR = "false";
    await expect(
      editTurn(file, { ...parts, draft: "kept" }),
    ).resolves.toBeNull();
  });

  test("an empty messsage, as from :q on a fresh turn, returns null", async () => {
    process.env.EDITOR = "true";
    await expect(editTurn(file, parts)).resolves.toBeNull();
  });

  test("a message of exactly :q returns null", async () => {
    process.env.EDITOR = editorWriting(`:q\n${SCISSORS}\n`);
    await expect(editTurn(file, parts)).resolves.toBeNull();
  });

  test("an editor not on PATH rejects with its command", async () => {
    process.env.EDITOR = "grey-no-such-editor --flag";
    await expect(editTurn(file, parts)).rejects.toThrow(
      "Failed to open editor 'grey-no-such-editor --flag'",
    );
  });

  test("the event lopp keeps running while the editor is open", async () => {
    process.env.EDITOR = "sh -c 'sleep 0.2'";
    const order: string[] = [];
    setTimeout(() => order.push("timer"), 0);
    await editTurn(file, parts);
    order.push("editor closed");
    expect(order).toEqual(["timer", "editor closed"]);
  });
});
