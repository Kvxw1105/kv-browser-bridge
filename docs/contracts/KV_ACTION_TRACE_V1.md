# KV Action Trace V1

Each RunEvent stores an ordered request/result pair: method, operation class, optional tab ID, redacted parameters, result or error, and timestamp.

Sensitive parameter keys and free-text inputs are redacted before SQLite persistence. Browser screenshots are file Artifacts with SHA-256 metadata.
