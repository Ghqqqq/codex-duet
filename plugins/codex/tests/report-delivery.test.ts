import { test, expect } from 'claude-code/testing';
import type { PromptSubmitInput } from 'claude-code';

// The engine test exercises registration/composition and persistent store use.
// tests/report-delivery.test.mjs runs the same module with the real Node helper,
// regular task-output files, foreign/adopted jobs and the actual C2 serializer.
test('host composer endings and task notifications attach once, preserve prompts, and fail closed', async ($, on) => {
  const report = { status: 'completed', worker: 'Ada', jobId: 'task-fixture', summary: '\u0001'.repeat(8000), next: null, details: 'duet result Ada --details' };
  const entry = `Duet report for background task bg-a:\n${JSON.stringify(report)}`;
  const saved = new Map<string, unknown>();
  const seen: PromptSubmitInput[] = [];
  let processes = 0;
  let endingNoticed = false, failLookup = false, emitted = false, claimThenDeliver = false, dropNext = false;
  let releases = 0, marks = 0, claimSequence = 0;
  let now = 1800000000000, claim: { token: string; at: number } | null = null;
  let failure = '', failOnce = false, failuresLeft = 0;
  // Mock helper contract; the Node test checks the exported TTL and real expiry.
  const ENDING_CLAIM_TTL_MS = 600000;
  const ending = { worker: 'Tesla-3', jobId: 'task-lost', status: 'interrupted', reason: 'owner_stopped', details: "duet result 'task-lost' --details" };
  on('session.id', () => ({ value: 'session-a' }));
  on('clock.now', () => ({ value: 1800000000000 }));
  on('store.keys', () => ({ value: [...saved.keys()] }));
  on('store.delete', ($, e) => { saved.delete(e.key); return { value: undefined }; });
  on('store.get', ($, e) => ({ value: saved.get(e.key) }));
  on('store.set', ($, e) => { saved.set(e.key, e.value); return { value: undefined }; });
  on('process.run', ($, e) => {
    processes++;
    expect(e.argv[0]).toBe('node');
    expect(e.argv[1]!.endsWith('/scripts/lib/report-delivery.mjs')).toBe(true);
    const request = JSON.parse(e.init!.stdin!);
    expect(request.sessionId).toBe('session-a');
    if (e.argv[2] === '--claim-unreported') {
      const entries = failLookup || endingNoticed || emitted || claim && claim.at > now - ENDING_CLAIM_TTL_MS ? []
        : [{ ...ending, token: `00000000-0000-4000-8000-${(++claimSequence).toString(16).padStart(12, '0')}` }];
      if (entries.length) claim = { token: entries[0]!.token, at: now };
      // A concurrent result consumer can arrive after the atomic claim. The
      // claim remains owned, and no following composer may claim it again.
      if (claimThenDeliver && entries.length) emitted = true;
      const lost = failure === 'lost-response' && failOnce && entries.length > 0;
      if (lost) failOnce = false;
      return { value: { exitCode: failLookup || lost ? 1 : 0, stdout: lost ? '' : JSON.stringify(entries), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
    }
    if (['--release-noticed', '--confirm-noticed'].includes(e.argv[2]!)) {
      expect(request.claims).toEqual([{ jobId: ending.jobId, token: claim!.token }]);
      if (e.argv[2] === '--confirm-noticed' && failuresLeft > 0) {
        const attempt = failuresLeft--;
        return { value: { exitCode: attempt === 2 ? 1 : 0, stdout: attempt === 3 ? 'null' : '{"ok":true}',
          stderr: '', isStdoutTruncated: attempt === 1, isStderrTruncated: false } };
      }
      const failed = e.argv[2] === `--${failure}-noticed` && failOnce;
      if (failed) failOnce = false;
      else {
        if (e.argv[2] === '--confirm-noticed') endingNoticed = true;
        else releases++;
        claim = null;
      }
      return { value: { exitCode: 0, stdout: failed ? 'null' : '{"ok":true}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
    }
    if (e.argv[2] === '--mark-delivered') {
      expect(request.jobId).toBe(report.jobId);
      expect(request.status).toBe('completed');
      expect(seen.at(-1)!.context?.includes(entry)).toBe(true);
      marks++; emitted = true;
      return { value: { exitCode: 0, stdout: '{"ok":true}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(['duet-fixture', 'drop-fixture'].includes(request.text)
      ? { taskId: request.text === 'duet-fixture' ? 'bg-a' : 'bg-drop', jobId: report.jobId, status: report.status, entry } : null), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on('prompt.submit', ($, e) => {
    seen.push(e);
    if (dropNext) { dropNext = false; return { drop: 'fixture gate' }; }
    return { text: e.text };
  });
  await $.prompt.submit({ text: 'duet-fixture', origin: { kind: 'task-notification' }, context: ['existing'] });
  expect(seen.at(-1)!.context?.length).toBe(2);
  expect(seen.at(-1)!.context![0]).toBe('existing');
  expect(seen.at(-1)!.context![1] === entry).toBe(true);
  expect(JSON.parse(seen.at(-1)!.context![1]!.split('\n')[1]!)).toEqual(report);
  await $.prompt.submit({ text: 'duet-fixture', origin: { kind: 'task-notification' } });
  expect(seen.at(-1)!.context).toBe(undefined);
  for (const text of ['foreign-session-fixture', 'non-duet-fixture']) {
    await $.prompt.submit({ text, origin: { kind: 'task-notification' } });
    expect(seen.at(-1)!.context).toBe(undefined);
  }
  const before = processes;
  await $.prompt.submit({ text: 'duet-fixture', origin: { kind: 'person' } });
  expect(processes).toBe(before);
  expect(seen.at(-1)!.context).toBe(undefined);
  expect(saved.size).toBe(1);
  expect(marks).toBe(1);
  emitted = false;
  // Let the other prompt hook announce native readiness before this check.
  endingNoticed = true;
  await $.prompt.submit({ text: 'bootstrap', origin: { kind: 'composer' } } as PromptSubmitInput);
  endingNoticed = false;
  const composer = { text: 'continue', origin: { kind: 'composer' }, context: ['existing'] } as PromptSubmitInput;
  const acceptedStart = processes;
  await $.prompt.submit(composer);
  expect(processes).toBe(acceptedStart + 2);
  expect(endingNoticed).toBe(true);
  expect(seen.at(-1)!.text).toBe(composer.text);
  expect(seen.at(-1)!.origin).toEqual(composer.origin);
  expect(seen.at(-1)!.context?.[0]).toBe(composer.context![0]);
  await $.prompt.submit(composer);
  expect(seen.at(-1)!.context).toEqual(composer.context);
  endingNoticed = false; emitted = false; dropNext = true;
  const beforeMarks = marks;
  await $.prompt.submit({ text: 'drop-fixture', origin: { kind: 'task-notification' } });
  expect(marks).toBe(beforeMarks);
  expect(emitted).toBe(false);
  await $.prompt.submit(composer);
  expect(seen.at(-1)!.context?.length).toBe(2);
  expect(endingNoticed).toBe(true);
  await $.prompt.submit(composer);
  expect(seen.at(-1)!.context).toEqual(composer.context);
  endingNoticed = false; dropNext = true;
  const rejectedStart = processes;
  await $.prompt.submit(composer);
  expect(processes).toBe(rejectedStart + 2);
  expect(releases).toBe(1);
  expect(endingNoticed).toBe(false);
  await $.prompt.submit(composer);
  expect(endingNoticed).toBe(true);
  endingNoticed = false; claimThenDeliver = true;
  await $.prompt.submit(composer);
  expect(seen.at(-1)!.context?.length).toBe(2);
  expect(emitted).toBe(true);
  const emptyStart = processes;
  await $.prompt.submit(composer);
  expect(seen.at(-1)!.context).toEqual(composer.context);
  expect(processes).toBe(emptyStart + 1);
  endingNoticed = false; emitted = false; claimThenDeliver = false;
  for (const kind of ['release', 'lost-response', 'confirm']) {
    endingNoticed = false; claim = null; failure = kind; failOnce = true;
    dropNext = kind === 'release';
    const start = processes;
    await $.prompt.submit(composer);
    expect(processes).toBe(start + (kind === 'lost-response' ? 1 : 2));
    expect(endingNoticed).toBe(false);
    expect(claim === null).toBe(false);
    if (kind === 'lost-response') expect(seen.at(-1)!.context).toEqual(composer.context);
    now += ENDING_CLAIM_TTL_MS - 1;
    const beforeLive = processes;
    await $.prompt.submit(composer);
    expect(processes).toBe(beforeLive + 1);
    expect(seen.at(-1)!.context).toEqual(composer.context);
    now++;
    const beforeExpired = processes;
    await $.prompt.submit(composer);
    expect(processes).toBe(beforeExpired + 2);
    expect(seen.at(-1)!.context?.length).toBe(kind === 'confirm' ? 1 : 2);
    expect(endingNoticed).toBe(true);
    expect(claim).toBe(null);
    now += ENDING_CLAIM_TTL_MS;
    await $.prompt.submit(composer);
    expect(seen.at(-1)!.context).toEqual(composer.context);
  }
  endingNoticed = false; claim = null; failure = ''; failuresLeft = 3;
  for (let round = 0; round < 4; round++) {
    const beforeRetry = processes;
    await $.prompt.submit(composer);
    expect(processes).toBe(beforeRetry + 2);
    expect(seen.at(-1)!.context?.length).toBe(round === 0 ? 2 : 1);
    expect(endingNoticed).toBe(round === 3);
    now += ENDING_CLAIM_TTL_MS;
  }
  expect(failuresLeft).toBe(0);
  const afterConfirmed = processes;
  await $.prompt.submit(composer);
  expect(processes).toBe(afterConfirmed + 1);
  expect(seen.at(-1)!.context).toEqual(composer.context);
  endingNoticed = false; failure = ''; failLookup = true;
  await $.prompt.submit(composer);
  expect(seen.at(-1)).toEqual(composer);
  expect(endingNoticed).toBe(false);
});
