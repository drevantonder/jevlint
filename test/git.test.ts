import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { collectChangedFiles } from "../src/git.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "jevlint-git-"));
  await git(cwd, "init", "-q");
  await git(cwd, "config", "user.name", "Test");
  await git(cwd, "config", "user.email", "test@example.com");
  await writeFile(join(cwd, "tracked.ts"), "export const value = 1;\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "initial");
  return cwd;
}

describe("collectChangedFiles", () => {
  it("collects changed lines and untracked JavaScript or TypeScript files", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "tracked.ts"), "export const value = 2;\n");
    await writeFile(join(cwd, "new.ts"), "export const added = true;\n");
    await writeFile(join(cwd, "ignored.txt"), "not source\n");

    const files = await collectChangedFiles({ cwd, staged: false });

    expect(files.map((file) => file.filePath)).toEqual(["new.ts", "tracked.ts"]);
    expect(files[0]?.changedLines).toEqual([{ start: 1, end: 1 }]);
    expect(files[0]?.oldSource).toBeNull();
    expect(files[1]?.changedLines).toEqual([{ start: 1, end: 1 }]);
    expect(files[1]?.oldSource).toBe("export const value = 1;\n");
  });

  it("reads staged content rather than later working-tree edits", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "tracked.ts"), "export const value = 2;\n");
    await git(cwd, "add", "tracked.ts");
    await writeFile(join(cwd, "tracked.ts"), "export const value = 3;\n");

    const files = await collectChangedFiles({ cwd, staged: true });

    expect(files).toHaveLength(1);
    expect(files[0]?.source).toBe("export const value = 2;\n");
    expect(files[0]?.oldSource).toBe("export const value = 1;\n");
  });
});
