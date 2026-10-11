export type Nudge = { tip: string; next: string }

declare module 'claude-code' {
  interface PluginState {
    'phro-prompt-nudge': { nudge: Nudge | null; isOff: boolean }
  }
}
