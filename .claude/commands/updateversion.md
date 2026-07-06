---
description: Set or bump the GenesisCA version (major/minor/patch or an explicit X.Y.Z) across every file that records it, auto-write the CHANGELOG entry from the commits since the last release, optionally commit, and print a ready-to-paste GitHub PR message.
argument-hint: <X.Y.Z | major | minor | patch> [commit]
allowed-tools: Read, Edit, Write, Grep, Bash
---

Update the GenesisCA project version. Requested change: **$ARGUMENTS**

Change ONLY version strings and the CHANGELOG entry — touch nothing else. Follow these steps exactly.

## 0. Parse the arguments

The arguments are one or two whitespace-separated tokens, in any order:

- a **version directive** — exactly one of `major` / `minor` / `patch` / an explicit
  `X.Y.Z` (matching `^\d+\.\d+\.\d+$`). REQUIRED.
- an optional **`commit`** flag (case-insensitive) — if present, you will also create a
  git commit at the end (step 6). If absent, leave the changes in the working tree.

Extract them: treat a standalone `commit` token as the flag and remove it; the remaining
token is the version directive. If, after removing an optional `commit`, there is no valid
version directive (empty, or an unrecognized token), **STOP, make no changes, and ask the
user** which version they want.

## 1. Read the current version

Read `package.json` and take its top-level `"version"` field (format `X.Y.Z`, e.g.
`1.24.0`). Call it **OLD** and split it into integer parts `major`, `minor`, `patch`.

## 2. Compute the NEW version from the directive

Match the version directive **case-insensitively**:

- `major` → `(major+1).0.0`  (minor and patch reset to 0)
- `minor` → `major.(minor+1).0`  (patch resets to 0)
- `patch` → `major.minor.(patch+1)`
- an explicit version that matches `^\d+\.\d+\.\d+$` (e.g. `1.17.1`) → use it verbatim

Call the result **NEW**. If `NEW === OLD`, report that nothing changed and stop.

## 3. Replace the version in EVERY location

`OLD` is recorded in several files (the project's "Version display" rule in CLAUDE.md).
Update them all to `NEW`, matching the exact `OLD` string so no unrelated number is touched:

1. **`package.json`** — the top-level `"version": "OLD"`.
2. **`package-lock.json`** — TWO occurrences of `"version": "OLD"`: the top-level one
   (near line 3, 2-space indent) AND the `"packages"` → `""` entry (near line 9, 6-space
   indent). Because their indentation differs, a single `replace_all` on `"version": "OLD"`
   may only hit one — Read the top of the file and update BOTH occurrences (verify in step 5).
3. **`src/App.tsx`** — the header badge text `vOLD` inside the `.version` span.
4. **`README.md`** — the title badge `<sup>vOLD</sup>` on line 1.

## 4. Auto-write the CHANGELOG entry from the release's commits

`CHANGELOG.md` at the repo root drives the GitHub Release notes (see
`.github/workflows/release.yml` → "Compose release notes"): the `## [NEW]` section becomes
the release body. Generate that section NOW from the commits that make up this release —
do not leave it blank.

1. Get today's date: run `date +%F`.
2. Find the previous release baseline — the most recent version tag reachable from HEAD:
   `git describe --tags --match "v*" --abbrev=0 HEAD` (call it **PREV**; if the command
   fails because no tag exists yet, treat the whole history as the range).
3. List the commits in this release:
   `git log PREV..HEAD --no-merges --pretty=format:"%h %s"`
   (if there is no PREV, drop `PREV..`). This is the same range the release will tag.
4. Synthesize a **curated, categorized** entry from those commits — NOT a raw commit dump.
   Read the subjects; run `git show -s <hash>` on any subject too terse to classify. Then:
   - Group related commits into a few thematic sections with `###` headings (e.g.
     `### Agents — brush parity`, `### Simulator`, `### Fixes`), each with concise prose
     bullets describing what changed for a user/reader.
   - Fold several commits on one feature into a single bullet.
   - Omit pure-noise commits (WIP/scratch models, internal doc/CLAUDE.md syncs, and the
     `chore: bump version` commit itself) unless they are user-visible.
   - Match the tone and shape of the existing entries already in `CHANGELOG.md`.
   - Lead with a one-line summary sentence if the batch is large.
   This section doubles as the PR description for the release branch, so make it good.
5. Read `CHANGELOG.md`. If it does not exist, create it with a `# Changelog` header block
   first. Then:
   - If a `## [NEW]` section already exists, REPLACE its body with the freshly generated
     content (keep the heading + date).
   - Otherwise **prepend** a new `## [NEW] - <today>` section immediately ABOVE the most
     recent existing `## [` entry (newest-first), with a blank line between sections.
   - If there are genuinely no commits since PREV, write a single short bullet noting that
     (e.g. a version-only bump) instead of fabricating content.

## 5. Verify

Grep the repo for the old strings `vOLD` (in `src/App.tsx` + `README.md`) and confirm
`package.json` / `package-lock.json` no longer contain `"version": "OLD"`. Confirm
`CHANGELOG.md` has a populated `## [NEW]` section.

## 6. Commit (only if the `commit` flag was given)

If — and only if — the `commit` flag was present in the arguments:

- Stage exactly the touched files: `git add package.json package-lock.json src/App.tsx README.md CHANGELOG.md`
- Commit with the message **`chore: bump version to vNEW`** (this exact prefix is what the
  release workflow filters out of its auto changelog — do not change the wording).
- Do NOT push. Do NOT add a Co-Authored-By line.

If the flag was absent, leave everything as unstaged working-tree changes.

## 7. Report

Report `OLD → NEW`, the files changed, a one-line note of what the generated CHANGELOG
section covers, and whether a commit was created (with its short hash) or the changes were
left in the working tree.

## 8. Print the PR message for GitHub

ALWAYS (whether or not you committed) print a ready-to-paste GitHub PR message derived from
the `## [NEW]` CHANGELOG section, so the user can drop it straight into the pull request.
Print it in your reply — do NOT write it to a file:

- A suggested **title** line: `vNEW — <2–5 word theme of the batch>`.
- The **body**: the curated section content (the `###` groups + bullets, with the one-line
  summary sentence if present, but WITHOUT the `## [NEW] - <date>` heading line). Present the
  body inside a fenced ```` ```markdown ```` block so it copies verbatim.

Do NOT include any Claude/Anthropic attribution line in the PR message (project rule).
