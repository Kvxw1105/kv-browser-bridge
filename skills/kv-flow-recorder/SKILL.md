---
name: kv-flow-recorder
description: Record and refine reusable Kv Browser Bridge workflows when the user asks to record, retain, or reuse a browser process.
---

# Kv Flow Recorder

Use this Skill only for an explicit workflow-recording request. A recording is a reviewable draft, never silently promoted automation.

1. Identify the exact Chrome tab with `browser_get_tabs` or `browser_snapshot`, then call `browser_record_start` with the `tabId` and a concise outcome. Keep `recordInputValues` off unless the user expressly asks to retain ordinary form text.
2. Perform the task with normal Kv Browser Bridge tools. The recorder captures agent steps, manual clicks, semantic locators, viewport-relative geometry, and page fingerprints.
3. At a CAPTCHA, login or account ambiguity, risk prompt, selector mismatch, or other blocker, call `browser_record_note` with the precise checkpoint. Explain the required manual action and wait for the user's intervention.
4. Re-read the targeted page state after intervention, resume the task, and retain the active recording.
5. Call `browser_record_stop` at completion. Review the returned workflow draft: steps, semantic targets, geometry, preconditions, postconditions, checkpoints, confidence, and reuse recommendation.

## Hybrid Execution Policy

- Use coordinate fast paths only when the page fingerprint, viewport range, and local container are stable.
- Use container-relative coordinates for canvas, timelines, sliders, drag, and visually laid-out controls.
- Use semantic selectors or accessible names for forms, dynamic lists, navigation, and consequential actions.
- On mismatch, verify the target semantically first, then get a localized snapshot or screenshot only when needed.
- Passwords, OTPs, tokens, cookies, and secrets must remain redacted.

## Learnings

- Coordinates optimize stable workflows; they are never the only source of truth.
- Every reusable coordinate step needs a fingerprint and semantic recovery route.
- A workflow becomes durable experience only after the user reviews its outcome and checkpoints.
