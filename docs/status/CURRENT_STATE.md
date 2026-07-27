# Current State

- Shadow Runtime, WAL SQLite, migrations, Run Package export, Draft review, and manual replay MCP commands are coded.
- `npm run build:local-chrome`, Runtime tests, and the synthetic Run Package to guide CLI path have passed locally.
- Real Chrome Recorder evidence: `flow-1785177464580-zqw60k` recorded a public GitHub page URL without page mutation. Screenshot capture was blocked by an existing debugger attachment and became `SCREENSHOT_FAILED` human guidance; no screenshot artifact was produced.
- Runtime Shadow and Recorder UI have not yet been accepted with the test Extension/Native Host loaded.
