# Contributing

## Reporting Issues

Open a GitHub issue. Include:

- What you tried (command, URL, config)
- What happened (error message, unexpected output)
- What you expected
- Node version (`node --version`)

## Suggesting Improvements

Open a GitHub issue with the label `enhancement`. Describe:

- The problem or gap
- Your proposed solution
- Which WCAG criterion it relates to (if applicable)

## Pull Requests

1. Fork the repository
2. Create a branch from `main`
3. Make your changes
4. Run the full test suite: `cd tools && npm install && npm test`
   (unit + integration; requires `npx playwright install chromium` once)
5. If you changed shared helpers or the merger, add a test for the
   behavior you fixed — the CI runs these on every push
6. Submit a PR with a clear description of what changed and why

## Scope

This toolkit targets WCAG 2.2 Level AA. Contributions outside this scope (WCAG AAA, ARIA Authoring Practices, browser extension features) are unlikely to be accepted.

## Code Style

- Tools are ESM (`.mjs`). No build step.
- Methodology documents are Markdown with pipe tables.
- Findings use the JSONL schema in `templates/findings-schema.md`.
