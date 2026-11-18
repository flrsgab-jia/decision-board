# Decision board

A Claude Code add-on (a "mod") that puts a **Decisions** pane beside the chat. Whenever Claude needs a call from you, it adds a numbered card (D1, D2, ...) with its recommendation. You answer with one click instead of scrolling back through the chat to find the question.

```
D12 · Sample Co · 4m
Keep the 2026 bank column, or drop it?
[A. Keep it, never score it (recommended)]
   Keeps the current year on the page.
[B. Drop it]
   No 2026 column on AFS-basis deals.
[Other]
────────────────────────────────────────
D13 · Main desk · 1m
...
```

## Install (one time, about 2 minutes)

1. **Install the board.** In Claude Code, type this at the prompt:
   ```
   /plugin install decision-board --marketplace flrsgab-jia/decision-board
   ```
   Answer `y` when asked to add the marketplace, then press Enter to pick the **user** scope. That puts it in every session you start.
2. **Check it.** Type `/board`. The Decisions pane opens and says "Nothing waiting on you."

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, then **Add marketplace**. Enter `flrsgab-jia/decision-board`, then **Add plugin** and pick decision-board.

## Using it

- **Answer a card:** click an option. Claude gets `D12: <your choice>`, acts on it and closes the card.
- **Recommended:** the option Claude recommends is marked "(recommended)". Cards with no options show a recommendation and **OK** / **Reply** instead.
- **Your own answer:** click **Other** (or **Reply**), type it and press Enter.
- **Answer by typing:** you can also type in the chat, e.g. `D12 go with B`. It works the same.
- **Batch cards:** one card with numbered lines, each with its recommendation marked "(reco)" and 2 to 4 choices. **Approve all recos** takes every recommendation in one click. To change some lines, click the choice you want on those lines (● shows what's selected), then **Sign off**: lines you didn't touch keep the recommendation. Claude gets one answer listing every line.
- **Status line:** shows how many decisions are open. `/board` reopens the pane if you closed it.
- **Cards stay** until they're answered, even if you close Claude Code.
- **Ask Claude to use it:** Claude uses the board on its own when it needs a decision. To nudge it, say "put that on the board". To see what's open, ask "what's on the board?".
- **More than one session:** if several Claude sessions are working for you at once, they can all add cards to the same board. Closing a card always takes your answer, never another session's word.

Sign-off recording (cards with `confirm` or `batch` values that save a decision into a project file) only works in the workspace it was built for, which has a `.claude/coordinator/confirm.py` script. Without it, cards still work; the click just isn't saved to a file.

## Updating

Type `/plugin`, open decision-board in the list, and update it from there.

## Problems

- **The pane doesn't show:** type `/board`. On a very narrow window the pane waits until there's room, so widen the terminal.
- **Anything else:** ask Claude: "the decision board isn't working, can you check?"

## For developers

The code is in `hooks/register.tsx`. Run it with `claude --plugin-dir .` from this folder. Check it with `claude plugin validate .` and `claude plugin test .`. Claude adds and closes cards through three tools: `mcp__decision-board__add`, `close` and `list`.
