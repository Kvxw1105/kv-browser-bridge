# Handoff

1. Build the Runtime worktree: `npm run build:local-chrome`.
2. Start Chrome Bridge with `KBB_RUNTIME_MODE=shadow`.
3. Record with `browser_record_start` and `browser_record_stop`.
4. Review with `browser_recipe_review`; replay one approved step at a time with `browser_replay_step` and `confirmWrite=true` for writes.
5. Export with `browser_run_export`, then generate the guide with `npm run guide:run -- <package-directory>`.
