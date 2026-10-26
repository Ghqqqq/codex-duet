import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
const MAX_INLINE_UNTRACKED_BYTES = 256 * 1024;
const MAX_INLINE_UNTRACKED_FILES = 32;
const MAX_GIT_METADATA_BYTES = 8 * 1024 * 1024;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  const result = runCommand("git", args, { cwd, maxBuffer: MAX_GIT_METADATA_BYTES, ...options, shell: false });
  // Diff measurement supplies its own buffer and handles overflow as a size signal.
  if (options.maxBuffer === undefined && result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    throw new Error(`Review Git output exceeded the ${MAX_GIT_METADATA_BYTES} byte metadata limit (git ${args[0]}). Reduce the review scope or inspect the repository manually.`);
  }
  return result;
}

function gitChecked(cwd, args, options = {}) {
  const result = git(cwd, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(formatCommandFailure(result));
  return result;
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  validateReviewBase(cwd, baseRef);
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      const branch = remoteHead.slice("refs/remotes/origin/".length);
      const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return local.status === 0 && !local.error ? branch : `origin/${branch}`;
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  cwd = getRepoRoot(cwd);
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only", "-z"]).stdout.split("\0").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only", "-z"]).stdout.split("\0").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout.split("\0").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  cwd = ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    validateReviewBase(cwd, baseRef);
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    validateReviewBase(cwd, detectedBase);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  validateReviewBase(cwd, detectedBase);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function validateReviewBase(cwd, baseRef) {
  const result = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Review base ${JSON.stringify(baseRef)} does not resolve to a commit. Pass --base <existing-ref> or use --scope working-tree.`);
  }
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath, budget) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  const omit = (reason) => {
    budget.omitted.push({ path: relativePath, size: stat?.size ?? null, reason });
    return `### ${relativePath}\n(${reason})`;
  };
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return omit("skipped: broken symlink or unreadable file");
  }
  if (stat.isSymbolicLink()) {
    return omit("symlink, not inlined");
  }
  if (stat.isDirectory()) {
    return omit("skipped: directory");
  }
  if (!stat.isFile()) {
    return omit("skipped: not a regular file");
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return omit(`skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit`);
  }
  if (budget.files >= MAX_INLINE_UNTRACKED_FILES || budget.bytes + stat.size > MAX_INLINE_UNTRACKED_BYTES) {
    omit("skipped: aggregate untracked inline budget");
    return "";
  }

  let buffer;
  try {
    const file = fs.realpathSync(absolutePath);
    const relative = path.relative(fs.realpathSync(cwd), file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return omit("skipped: outside repository");
    }
    buffer = fs.readFileSync(file);
  } catch {
    return omit("skipped: broken symlink or unreadable file");
  }
  if (!isProbablyText(buffer)) {
    return omit("skipped: binary file");
  }

  const content = [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
  const bytes = Buffer.byteLength(content, "utf8") + 2;
  if (buffer.length > MAX_UNTRACKED_BYTES || budget.bytes + bytes > MAX_INLINE_UNTRACKED_BYTES) {
    omit("skipped: aggregate untracked inline budget");
    return "";
  }
  budget.bytes += bytes;
  budget.files += 1;
  return content;
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const entries = gitChecked(cwd, ["status", "--short", "--untracked-files=all", "-z"]).stdout.split("\0").filter(Boolean);
  const statusLines = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index], code = entry.slice(0, 2), file = JSON.stringify(entry.slice(3));
    // In -z status, a rename/copy lists its destination before its source.
    statusLines.push(`${code} ${/[RC]/.test(code) ? `${JSON.stringify(entries[++index])} -> ` : ""}${file}`);
  }
  const status = statusLines.join("\n");
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);
  const budget = { bytes: 0, files: 0, omitted: [] };
  const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file, budget)).filter(Boolean).join("\n\n");

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }
  if (budget.omitted.length) {
    parts.push(formatSection("Untracked Omission Manifest", budget.omitted.map(entry =>
      `- ${JSON.stringify(entry.path)}: ${entry.size ?? "unknown"} bytes (${entry.reason})`).join("\n")));
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles,
    untrackedInlineBytes: budget.bytes,
    untrackedInlineFiles: budget.files,
    omittedUntracked: budget.omitted
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", "-z", comparison.commitRange]).stdout.split("\0").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", "-z", comparison.commitRange]).stdout.split("\0").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }) + (details.omittedUntracked?.length
      ? " Read the omitted regular files listed in the Untracked Omission Manifest yourself with read-only commands before finalizing findings; do not follow symlinks outside the repository. Report any files you could not inspect."
      : ""),
    ...details
  };
}
