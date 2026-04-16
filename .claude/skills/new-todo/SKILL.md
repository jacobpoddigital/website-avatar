---
name: new-todo
description: Create a new to-do / planned work document in the output/ folder. Use when the user says "new todo", "create a todo list", "start today's list", "write up what we're working on", or "/new-todo".
version: 1.0.0
---

# Website Avatar — New To-Do Skill

Creates a fresh `output/todo-YYYY-MM-DD-<timeofday>.md` in the style of the project's existing planned-work documents.

---

## Step 1 — Determine filename and branch

Run both of these via Bash:

```bash
date "+%Y-%m-%d %H"
```
```bash
git branch --show-current
```

Map the hour (local) to a time-of-day label:
- 06–11 → `morning`
- 12–16 → `afternoon`
- 17–20 → `evening`
- 21–05 → `night`

Target filename: `output/todo-<date>-<timeofday>.md`

If a file with that exact name already exists in `output/`, inform the user and ask whether to append to it or pick a different suffix.

---

## Step 2 — Gather items

Ask the user:

> "What's going on today's list?"

Accept however much detail they give — a title only, a title + rough notes, or a full description. Collect all items, asking "Anything else?" until they say no or indicate they're done.

---

## Step 3 — Format each item

Use the **bold-label style** from `todo-2026-04-06.md` — NOT `###` subheadings.

**Planning item (not yet done):**
```
## N. Item Title

**Goal:** One clear sentence on what this achieves.

**[Contextual label — e.g. Problem / Background / Current flow / Design]:**
Describe the current state, relevant context, or specific issue. Use bullets, code
fences, or inline `backticks` as needed. Only include sections that add value —
don't pad with empty headings.

**Files:**
- `path/to/file.js` — what changes here
- `path/to/other.js` — what changes here
```

**Already-completed item:**
```
## N. Item Title ✓ Done

**Implemented:**
- What was built

**Files changed:**
- `path/to/file.js` — what changed
```

**Rules:**
- If the user gives minimal detail, write a concise description from what they provided. Read relevant source files if needed to add accurate file paths or context.
- If they give rich detail, preserve it faithfully — do not summarise away specifics.
- Do not speculate about implementation details that weren't mentioned.
- Use `---` separators between items.
- Items are numbered sequentially starting at 1.

---

## Step 4 — Write the file

Assemble and write the complete file. Structure:

```
# Website Avatar — Planned Work <YYYY-MM-DD>

---

## 1. ...

---

## 2. ...

---

*Document created: <YYYY-MM-DD> | Branch: <branch>*
```

After writing, confirm the full path to the user.
