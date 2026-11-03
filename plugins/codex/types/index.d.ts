// Native-agent navigation metadata. Durable bindings remain the job authority.
export type CodexNativeActivity = {
  jobId: string;
  threadId: string;
  workspace: string;
  name: string;
  model: string;
  models?: Record<string, string>;
};

declare module 'claude-code' {
  interface PluginState {
    codex: { nativeAgents: Record<string, CodexNativeActivity> };
  }
}
