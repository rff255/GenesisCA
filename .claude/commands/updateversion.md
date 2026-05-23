---
description: Set or bump the GenesisCA version (major/minor/patch or an explicit X.Y.Z) across every file that records it.
argument-hint: <X.Y.Z | major | minor | patch>
allowed-tools: Read, Edit, Grep
---

Update the GenesisCA project version. Requested change: **$ARGUMENTS**

Change ONLY version strings — touch nothing else. Follow these steps exactly.

## 1. Read the current version

Read `package.json` and take its top-level `"version"` field (format `X.Y.Z`, e.g.
`1.16.0`). Call it **OLD** and split it into integer parts `major`, `minor`, `patch`.

## 2. Compute the NEW version from the argument

Trim the argument and match it **case-insensitively**:

- `major` → `(major+1).0.0`  (minor and patch reset to 0)
- `minor` → `major.(minor+1).0`  (patch resets to 0)
- `patch` → `major.minor.(patch+1)`
- an explicit version that matches `^\d+\.\d+\.\d+$` (e.g. `1.17.1`) → use it verbatim
- anything else, or an empty argument → **STOP, make no changes, and ask the user**
  which version they want.

Call the result **NEW**. If `NEW === OLD`, report that nothing changed and stop.

## 3. Replace the version in EVERY location

`OLD` is recorded in several files (the project's "Version display" rule in CLAUDE.md).
Update them all to `NEW`, matching the exact `OLD` string so no unrelated number is touched:

1. **`package.json`** — the top-level `"version": "OLD"`.
2. **`package-lock.json`** — TWO occurrences of `"version": "OLD"`: the top-level one
   (near line 3) AND the `"packages"` → `""` entry (near line 9). They're identical
   strings, so `replace_all` on `"version": "OLD"` in this file hits exactly both (no
   dependency uses that version). Update both.
3. **`src/App.tsx`** — the header badge text `vOLD` inside the `.version` span.
4. **`README.md`** — the title badge `<sup>vOLD</sup>` on line 1.

## 4. Verify and report

Grep the repo for the old strings `vOLD` (in `src/App.tsx` + `README.md`) and confirm
`package.json` / `package-lock.json` no longer contain `"version": "OLD"`. Then report
`OLD → NEW` and the files changed.

Do NOT create a git commit unless the user explicitly asks.
