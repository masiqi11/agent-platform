import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DomainError } from "../../core/errors";

/**
 * SBX-08: every path an agent tool touches is resolved and checked to stay inside the workspace,
 * following symlinks (a link inside the tree that points outside is rejected).
 */
export function resolveInWorkspace(root: string, p: string): string {
  if (typeof p !== "string" || !p.trim() || p.includes("\0")) throw new DomainError("invalid", "路径无效");
  const rootReal = realpathSync(root);
  const target = resolve(rootReal, isAbsolute(p) ? p.replace(/^\/+(workspace\/?)?/, "") : p);
  const inside = (x: string) => x === rootReal || x.startsWith(rootReal + sep);
  if (!inside(target)) throw new DomainError("forbidden", "路径超出工作区");
  // Walk up to the deepest existing ancestor and check its real path (symlink escape).
  let probe = target;
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = realpathSync(probe);
  if (!inside(real)) throw new DomainError("forbidden", "路径通过符号链接逃出工作区");
  const rel = relative(rootReal, target);
  if (rel.split(sep)[0] === ".git") throw new DomainError("forbidden", "不允许直接修改 .git 目录");
  return target;
}
