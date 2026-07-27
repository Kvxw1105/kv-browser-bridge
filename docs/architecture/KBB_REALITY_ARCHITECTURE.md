# KBB Reality Architecture

Chrome Extension remains the only browser controller. Chrome Bridge owns the Named Pipe and, in `KBB_RUNTIME_MODE=shadow`, writes Run evidence to SQLite without changing Pipe responses.

`legacy` creates no Runtime records. `shadow` writes Run, RunEvent, Artifact, and RecipeDraft records. `proxy` is reserved and has no browser-control behavior.

Replay routes each approved step back through the existing Bridge request path. It never launches a browser or bypasses final-action safeguards.
