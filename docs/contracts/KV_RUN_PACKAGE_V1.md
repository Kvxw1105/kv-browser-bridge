# KV Run Package V1

An exported package contains:

```text
manifest.json
events.jsonl
recipe-draft.json
result.json
artifacts/
```

Artifact paths are relative to the package and carry SHA-256 in `manifest.json`. Generate a local guide with:

```powershell
npm run guide:run -- <package-directory>
```
