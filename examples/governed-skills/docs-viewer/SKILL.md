---
name: docs-viewer
description: Read and search the project's documentation and skill library to answer "where is this documented / how does this work" questions. Read-only over docs/ and skills/. Use when a task is to look something up, summarize a doc, or locate a runbook — never to change anything.
---

# Docs Viewer (the clean in-scope example)

**Purpose.** The minimal, well-behaved governed skill: it answers documentation
questions by reading and grepping, and its declared `action_scope` is exactly
what it needs and nothing more. Use it as the template for a conformant skill.

**Declared blast radius.** `Read`/`Grep` over `docs/` and `skills/`. No write
tool, no execution, no other paths — so the tools it *may* touch and the tools
it *needs* are the same set. That is what "in scope" means.

## Steps

1. **Locate.** `Grep` `docs/` and `skills/` for the terms in the question.
2. **Read** the matching files.
3. **Answer with citations** — every claim names the doc path it came from.
4. **If the answer isn't in `docs/` or `skills/`, say so.** Do not reach for a
   path outside the declared scope to "go find it"; report the gap instead.
