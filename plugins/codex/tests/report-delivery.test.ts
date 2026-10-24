import { test, expect } from 'claude-code/testing';
import type { PromptSubmitInput } from 'claude-code';

// The engine test exercises registration/composition and persistent store use.
// tests/report-delivery.test.mjs runs the same module with the real Node helper,
// regular task-output files, foreign/adopted jobs and the actual C2 serializer.
test('host task notifications attach one complete helper report before next, with engine-store deduplication', async ($, on) => {
  const report = { status: 'completed', worker: 'Ada', jobId: 'task-fixture', summary: '\u0001'.repeat(8000), next: null, details: 'duet result Ada --details' };
  const entry = `Duet report for background task bg-a:\n${JSON.stringify(report)}`;
  const saved = new Map<string, unknown>();
  const seen: PromptSubmitInput[] = [];
  let processes = 0;
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
    return { value: { exitCode: 0, stdout: JSON.stringify(request.text === 'duet-fixture' ? { taskId: 'bg-a', entry } : null), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on('prompt.submit', ($, e) => { seen.push(e); return { text: e.text }; });
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
});
