/** Plain values a sign-off names: text, numbers, true/false. */
export type Values = Record<string, string | number | boolean>

/**
 * A card that is Gab's #172 sign-off on one exact item: the click records
 * confirmed_by_gab in borrowers/<borrower>/state.json (#181 piece 5).
 */
export type ConfirmSpec = {
  /** The exact borrowers/ folder name. */
  borrower: string
  /** The exact item key being signed off, e.g. revenue_basis. */
  item: string
  stage?: string
  /** The values an OK click signs off, on a card without options. */
  values?: Values
  /** Test runs: the click goes through confirm.py --dry-run and writes nothing. */
  dryRun?: boolean
}

export type Card = {
  id: number
  source: string
  ask: string
  recommendation: string
  /** Choices for the user, one row each; the one matching recommendation is marked. */
  options?: { label: string; description: string; values?: Values }[]
  addedAt: number
  confirm?: ConfirmSpec
  /** A newer card for the same borrower and item: this one takes no clicks. */
  supersededBy?: number
  /** Set once a click was recorded in state.json: the card takes no more clicks. */
  recorded?: { choice: string; at: number; dryRun?: boolean }
  /** A batch card (several items, one sign-off) instead of options/confirm. */
  batch?: BatchSpec
}

/** One choice on a card or a batch line. */
export type Option = { label: string; description: string; values?: Values }

/** One line of a batch card: an item, its recommendation and its choices. */
export type BatchLine = {
  /** The exact item key recorded in state.json, e.g. revenue_basis. */
  item: string
  /** The line in plain words, recorded as the confirmation's ask. */
  text: string
  /** The recommended option's exact label. */
  recommendation: string
  options: Option[]
}

/** A batch card: one borrower, one moment, several lines, one answer. */
export type BatchSpec = {
  /** The exact borrowers/ folder name. */
  borrower: string
  stage?: string
  dryRun?: boolean
  lines: BatchLine[]
}

export type Board = { next: number; cards: Card[] }

/** Batch picks not yet signed off: card id -> line index -> option index. */
export type Picks = Record<number, Record<number, number>>

declare module 'claude-code' {
  interface PluginState {
    'decision-board': { board: Shaped<Board>; minute: number; replying: number; picks: Picks }
  }
}
