# Handoff

1. The Runtime Shadow acceptance run is active through unpacked extension ID `jmebeacjecpedgahpckmgaiadnmfenhe`. Keep its `apps/extension/dist` directory loaded until the next acceptance decision.
2. Current primary evidence is under `artifacts/real-dashboard-evidence/run-285c25a0-c45e-46dc-8124-c85663a80bc6`; do not delete it. The earlier GitHub evidence remains under `artifacts/real-browser-evidence/`.
3. To perform another read-only workflow, start and stop the recorder, review via `browser_recipe_review`, then replay one approved step at a time with `browser_replay_step`. Writes still require `confirmWrite=true`.
4. Use `browser_run_generate_guide` for a package and guide in one local call. Verify the guide's `quality-report.md` before reporting success.
5. Restore the prior Native Messaging registration only when Runtime acceptance is finished: `node apps/chrome-bridge/dist/install.js test-restore`, then reload the stable unpacked extension.
6. For multiple Agent clients, configure distinct `KBB_CLIENT_ID`/`KBB_CLIENT_NAME` values in each stdio MCP definition. Leave coordination mode unset for observation-free legacy behavior; set `KBB_COORDINATION_MODE=observe` or `enforce` on the Bridge only after the dual-client harness passes. No real-browser verification is claimed by the compatibility/docs task.
