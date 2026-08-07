/**
 * fs.symlinkSync with an error a Windows user can act on.
 *
 * Creating a symlink on Windows needs SeCreateSymbolicLinkPrivilege, which a
 * normal account only holds with Developer Mode on. Without it every link this
 * tool draws — the two in ~/.agents, and one per skill per agent — dies with a
 * bare `EPERM: operation not permitted, symlink`, which names the syscall and
 * nothing else. Nothing in that message says the fix is a settings toggle or a
 * different shell, so it reads as a bug in the tool.
 *
 * The privilege cannot be acquired mid-process: Windows grants it at process
 * creation, so an already-running command cannot elevate itself. Both fixes
 * below are therefore about how the command is *started*.
 */
import fs from "node:fs";

const WIN = process.platform === "win32";

const HOWTO = [
  "Windows needs a privilege to create symlinks, and this process does not have it.",
  "Either is enough:",
  "  - Developer Mode on (Settings > System > For developers) — then nothing else changes",
  "  - run the command elevated: `sudo agent-skills ...`, or an elevated shell",
  "    (`sudo` ships with Windows 11 but is off by default; enable it on the same",
  "     settings page, and set it to run inline so output stays in this console)",
].join("\n");

export function symlinkSync(target: string, at: string): void {
  try {
    fs.symlinkSync(target, at);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (WIN && (code === "EPERM" || code === "EACCES")) {
      // `actionable` tells run.js to print this without a stack trace: the
      // advice is the whole message, and a stack only hides it.
      const e = new Error(`${(err as Error).message}\n\n${HOWTO}`);
      Object.assign(e, { actionable: true });
      throw e;
    }
    throw err;
  }
}
