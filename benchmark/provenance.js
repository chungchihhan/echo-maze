/**
 * Source provenance for benchmark artifacts.
 *
 * A commit hash alone does not describe a dirty checkout. The benchmark keeps
 * the commit plus a content hash of the tracked/non-ignored working tree and a
 * diff hash so exploratory dry runs remain inspectable and live runs can
 * enforce a clean source boundary.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

function gitText(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitBytes(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hashWorkingTree(cwd, relativePaths) {
  const hash = createHash("sha256");
  for (const relativePath of relativePaths) {
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");
    try {
      hash.update(readFileSync(path.resolve(cwd, relativePath)));
    } catch {
      // A deleted tracked file is part of the working-tree state too.
      hash.update("<missing>", "utf8");
    }
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function hashDiff(status, diff) {
  const hash = createHash("sha256");
  hash.update(status, "utf8");
  hash.update("\0", "utf8");
  hash.update(diff);
  return hash.digest("hex");
}

/**
 * @param {string} [cwd]
 * @returns {{ commit: string, dirty: boolean, sourceHash: string | null,
 *             diffHash: string | null, gitAvailable: boolean }}
 */
export function inspectGitProvenance(cwd = process.cwd()) {
  try {
    const commit = gitText(["rev-parse", "HEAD"], cwd).trim();
    const status = gitText(["status", "--porcelain", "--untracked-files=all"], cwd);
    const diff = gitBytes(["diff", "--binary", "HEAD", "--"], cwd);
    const files = gitBytes(["ls-files", "-c", "-o", "--exclude-standard", "-z"], cwd)
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();

    return {
      commit,
      dirty: status.length > 0,
      sourceHash: hashWorkingTree(cwd, files),
      diffHash: hashDiff(status, diff),
      gitAvailable: true,
    };
  } catch {
    return {
      commit: "unknown",
      dirty: true,
      sourceHash: null,
      diffHash: null,
      gitAvailable: false,
    };
  }
}
