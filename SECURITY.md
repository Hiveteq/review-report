# Security

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's **Security → Report a vulnerability** form on
GitHub. Do not open a public issue. You can expect an acknowledgement within a few days.

## What a report contains

A rendered report embeds the diff it explains, including any secrets or private code in that diff. Treat a report
like the source it was made from, and do not publish a report of code you would not publish.

## How the page is built

- **Diff text and notes are escaped.** Code lines, file paths, titles and Markdown in the story are HTML-escaped.
  Markdown links are allowed only for `http`, `https`, `mailto`, in-page anchors and relative paths.
- **One deliberate exception.** A story chapter may carry raw `html`, for a table or figure the author wants to
  show. It is inserted as written, so only render stories you or your agent wrote.
- **Third-party scripts.** The page loads highlight.js and Mermaid from cdnjs and jsDelivr at view time. Both are
  pinned to exact versions with subresource-integrity hashes, so a browser refuses a changed or tampered file.
- **Local storage.** Viewed ticks and display preferences are kept in the browser's local storage, per report.
  Nothing is sent anywhere.

## Supported versions

Only the latest release receives fixes.
