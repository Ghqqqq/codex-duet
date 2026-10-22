import { isolatedCodexCommand } from "./codex-home.mjs";
function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  if (job.sessionLabel) parts.push(`session: ${job.sessionLabel}`);
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatCodexResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return isolatedCodexCommand(["resume", job.threadId]);
}

function unansweredQuestion(job) {
  return (job.status === "queued" || job.status === "running") && job.pendingQuestion?.answer === undefined
    ? job.pendingQuestion
    : null;
}

function appendPendingQuestion(lines, job) {
  const question = unansweredQuestion(job);
  if (!question) return;
  lines.push("  Waiting for an answer:", `    ${question.text}`);
  for (const [index, option] of (question.options ?? []).entries()) {
    lines.push(`    ${index + 1}. ${option}`);
  }
  if (Number.isFinite(question.expiresAt)) {
    const seconds = Math.max(0, Math.ceil((question.expiresAt - Date.now()) / 1000));
    const remaining = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
    lines.push(`    Time left: ${remaining}${seconds === 0 ? " (expired)" : ""}.`);
  }
  lines.push("    Answer it in the Claude conversation that owns this worker.");
}

function appendActiveJobsTable(lines, jobs) {
  const showSession = jobs.some(job => job.sessionLabel);
  lines.push("Active jobs:");
  lines.push(`| Job | Kind | Status | Phase | Elapsed | Codex Session ID | Summary | Actions |${showSession ? " Claude session |" : ""}`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |${showSession ? " --- |" : ""}`);
  for (const job of jobs) {
    const actions = [`/codex:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/codex:cancel ${job.id}`);
    }
    if (job.adoptCommand) actions.push(job.adoptCommand);
    const status = job.orphaned ? `${job.status} (orphaned; ${job.leaseRemainingSec}s lease)` : job.status;
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(`${status}${unansweredQuestion(job) ? " (Waiting for an answer)" : ""}`)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |${showSession ? ` ${escapeMarkdownCell(job.sessionLabel)} |` : ""}`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.leaseRemainingSec != null) lines.push(`  Owner lease: ${job.orphaned ? "orphaned (owner not renewing)" : "recently renewed"}; ${job.leaseRemainingSec}s remaining.`);
  if (job.adoptCommand) lines.push(`  With the user's explicit consent, a replacement worker can adopt: ${job.adoptCommand}`);
  if (job.continuationCommand) lines.push(`  Lease expired; continuation (not started): ${job.continuationCommand}`);
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  appendPendingQuestion(lines, job);
  if (job.approvedBrowserOrigins) lines.push(`  Approved browser origins (this job): ${job.approvedBrowserOrigins.join(", ") || "none"}`);
  if (job.approvedComputerApps?.length) lines.push(`  Approved Computer Use apps (this job): ${job.approvedComputerApps.join(", ")}`);
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Codex session ID: ${job.threadId}`);
  }
  const resumeCommand = formatCodexResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Codex: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /codex:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /codex:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /codex:review --wait");
    lines.push("  Stricter review: /codex:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

function browserPolicyForNewTasks({ approval, preference = approval }) {
  if (approval === preference) return preference;
  if (approval === "ask" && preference === "never-ask") {
    return "never-ask (default; applied on first task)";
  }
  return `${approval} (file; preserved); preference: ${preference}`;
}

export function renderSetupReport(report) {
  const lines = [
    "# Codex Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- codex: ${report.codex.detail}`,
    `- auth: ${report.auth.detail}`,
    ...(report.tools ? [`- tools (configuration only): browser ${report.tools.browser}, computer-use ${report.tools.computerUse}, node_repl ${report.tools.nodeRepl}`] : []),
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    ...(report.defaultSandbox ? [`- default sandbox: ${report.defaultSandbox}`] : []),
    ...(report.browserOrigins ? [`- browser policy for new tasks: ${browserPolicyForNewTasks(report.browserOrigins)}`] : []),
    ""
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      "",
      "Codex did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Codex returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push("Codex review completed without any stdout output.");
  } else {
    lines.push("Codex review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  const origins = `${meta?.approvedBrowserOrigins?.length ? `Approved browser origins (this job): ${meta.approvedBrowserOrigins.join(", ")}\n` : ""}${meta?.approvedComputerApps?.length ? `Approved Computer Use apps (this job): ${meta.approvedComputerApps.join(", ")}\n` : ""}`.replace(/\n$/, "\n\n");
  if (rawOutput) {
    return origins + (rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`);
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "Codex did not return a final message.";
  return `${origins}${message}\n`;
}

export function renderStatusReport(report, options = {}) {
  const lines = [
    "# Codex Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push(options.all ? "No jobs recorded for this workspace." : "No jobs in this session. Run /codex:status --all to see jobs from other sessions in this workspace.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending the session will trigger a fresh Codex adversarial review and block if it finds issues.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Codex Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

function appendResultSection(lines, title, entries, format = String, omitted = 0) {
  if (!Array.isArray(entries) || !entries.length) return;
  lines.push("", `${title}:`);
  for (const entry of entries.slice(0, 8)) lines.push(`- ${format(entry)}`);
  const remaining = Math.max(0, entries.length - 8) + omitted;
  if (remaining > 0) lines.push(`+${remaining} more`);
}

function formatBlocker(blocker) {
  const identifiers = [
    ["app", blocker.app],
    ["tab", blocker.tabId ?? blocker.tab_id],
    ["session", blocker.sessionId ?? blocker.session_id]
  ].filter(([, value]) => value != null && value !== "");
  return `[${blocker.code}]${blocker.message ? ` ${blocker.message}` : ""}${identifiers.length ? ` (${identifiers.map(([key, value]) => `${key}: ${value}`).join(", ")})` : ""}`;
}

function resultNextAction(status, resumeCommand) {
  switch (status) {
    case "needs_input":
      return "Next: Answer the question in the Claude conversation that owns this worker.";
    case "blocked":
      return resumeCommand ? `Next: Resolve the blockers, then resume: ${resumeCommand}` : "Next: Resolve the blockers, then retry the task in the Claude conversation that owns this worker.";
    case "failed":
      return resumeCommand ? `Next: Address the failure, then resume: ${resumeCommand}` : "Next: Address the failure, then retry the task in the Claude conversation that owns this worker.";
    case "cancelled":
    case "interrupted":
      return resumeCommand ? `Next: Resume if you want to continue: ${resumeCommand}` : "Next: Start a new task in the Claude conversation if you want to continue.";
    default:
      return "Next: Review the result and evidence above.";
  }
}

export function renderStoredJobResult(job, storedJob) {
  const result = storedJob?.result ?? {};
  const report = storedJob?.report ?? {};
  const structured = result.structured;
  const status = report.status ?? storedJob?.status ?? job.status ?? "unknown";
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? isolatedCodexCommand(["resume", threadId]) : null;
  // Keep the final summary (or the existing formatted review) verbatim.
  const summary = isStructuredReviewStoredResult(storedJob) && storedJob?.rendered
    ? storedJob.rendered
    : result.rawOutput || result.codex?.stdout || structured?.summary || report.summary || storedJob?.rendered || job.summary || "";
  const lines = [`Outcome: ${status}`, "", summary];
  const errorMessage = job.errorMessage || storedJob?.errorMessage;
  if (errorMessage && !result.rawOutput && !result.codex?.stdout && !storedJob?.rendered) lines.push("", errorMessage);
  else if (!summary) lines.push("No captured result payload was stored for this job.");

  appendResultSection(lines, "Findings", structured?.keyFindings ?? report.keyFindings);
  appendResultSection(lines, "Verification (captured commands)", report.verification);
  if (report.verification?.length) lines.push(report.verificationBasis || "Captured command events; not independently verified.");
  appendResultSection(lines, "Claims not independently verified", structured?.verification ?? report.claimedVerification);
  appendResultSection(lines, "Assumptions", structured?.assumptions ?? report.assumptions);
  appendResultSection(lines, "Blockers", report.blockers, formatBlocker, report.blockersOmitted ?? 0);

  const question = structured?.question ?? report.question;
  if (status === "needs_input" && question && !summary.includes(question)) lines.push("", `Question: ${question}`);
  const origins = result.approvedBrowserOrigins ?? job.approvedBrowserOrigins ?? [];
  const apps = result.approvedComputerApps ?? job.approvedComputerApps ?? [];
  if (origins.length) lines.push("", `Approved browser origins (this job): ${origins.join(", ")}`);
  if (apps.length) lines.push("", `Approved Computer Use apps (this job): ${apps.join(", ")}`);
  if (threadId) lines.push("", `Codex session ID: ${threadId}`, `Resume in Codex: ${resumeCommand}`);
  lines.push("", resultNextAction(status, report.continuationCommand ?? job.continuationCommand ?? resumeCommand));
  return `${lines.join("\n")}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    "# Codex Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/codex:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
