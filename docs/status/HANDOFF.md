# Handoff

1. The Runtime Shadow acceptance run is active through unpacked extension ID `jmebeacjecpedgahpckmgaiadnmfenhe`. Keep its `apps/extension/dist` directory loaded until the next acceptance decision.
2. Current evidence is under `artifacts/real-browser-evidence/run-261fd644-9d2d-4bd2-9436-56585cfad698`; do not delete it.
3. To perform another read-only workflow, start and stop the recorder, review via `browser_recipe_review`, then replay one approved step at a time with `browser_replay_step`. Writes still require `confirmWrite=true`.
4. Use `browser_run_generate_guide` for a package and guide in one local call. Verify the guide's `quality-report.md` before reporting success.
5. Restore the prior Native Messaging registration only when Runtime acceptance is finished: `node apps/chrome-bridge/dist/install.js test-restore`, then reload the stable unpacked extension.
