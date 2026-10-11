export type Nudge = { tip: string; next: string }

/** One exchange line the mod recorded itself: the person's typed prompt or Claude's final answer. */
export type Line = { role: 'user' | 'assistant'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'phro-prompt-nudge': { nudge: Nudge | null; isOff: boolean; history: Line[] }
  }
}
