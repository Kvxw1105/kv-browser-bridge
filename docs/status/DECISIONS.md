# Decisions

- Use Node 22 `node:sqlite` rather than add a native dependency.
- Runtime is the sole SQLite writer and enables WAL.
- Shadow write failures are logged and do not alter browser request behavior.
- Keep the Functional Content Forge integration as a compatible local importer until the private Skill receives a native `import-kv-run-package` adapter.
- Keep installer-generated wrappers in legacy-compatible mode by default: omit `KBB_COORDINATION_MODE` unless an operator explicitly requests `off`, `observe`, or `enforce`. Client identity is supplied by each stdio MCP process through environment variables, not persisted in Chrome or browser storage.
