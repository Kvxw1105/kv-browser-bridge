# Handoff

1. Build the Runtime worktree: `npm run build:local-chrome`.
2. In `chrome://extensions`, remove the current unpacked Kv extension, load `apps/extension/dist` from this worktree, and copy its displayed extension ID.
3. Register the reversible Shadow test host: `node apps/chrome-bridge/dist/install.js test-install <extension-id>`. Reload that test extension.
3. Record with `browser_record_start` and `browser_record_stop`.
4. Review with `browser_recipe_review`; replay one approved step at a time with `browser_replay_step` and `confirmWrite=true` for writes.
5. Export with `browser_run_export`, then generate the guide with `npm run guide:run -- <package-directory>`, or use `browser_run_generate_guide` to do both locally in one command.
6. Restore the prior Native Messaging registration with `node apps/chrome-bridge/dist/install.js test-restore`, then reload the stable unpacked extension.
