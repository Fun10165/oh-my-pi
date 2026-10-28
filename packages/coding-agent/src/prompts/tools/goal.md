Manage active goal-mode objective.

The tool may be advertised before goal mode starts so the tool schema stays stable.
It is locked until the user explicitly invokes `/goal` or `/guided-goal`; before
that, every call is rejected. After a rejection, do not retry or call another op;
ask the user to start one of those commands. NEVER create a goal from your own
initiative: the objective's ground truth must come from a user instruction.

Single `op` field:
- `create`: starts goal; enables goal mode. Requires `objective`; optional positive `token_budget`. Only when no goal exists and none is paused.
- `get`: returns current active/paused goal and remaining token budget.
- `resume`: re-activates paused goal for continued work.
- `complete`: marks goal complete only when actually done and every deliverable verified against current evidence. NEVER because budget low or turn ending.
- `drop`: discards current goal without completing it and ends goal mode. When the tool is preloaded, it stays advertised but becomes locked again, so you cannot `create` a replacement (not even later in the same turn or eval cell). To change the objective, NEVER drop; ask the user to set the new goal.

Paused goal from `get` → the user must resume goal mode with `/goal`; NEVER resume it yourself.
