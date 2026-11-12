# Contributing

Thanks for looking. A few ground rules keep this small project easy to trust.

- **Read [AGENTS.md](AGENTS.md) first.** It has the layout, the commands and the rules for any change.
  It is written for coding agents, and it applies to people too.
- **Bug reports:** include the `--dump-numbered` output for the file involved and the story snippet that
  triggered it. Redact anything private.
- **Pull requests:** one problem each, titled `type(scope): summary` (see AGENTS.md), with the template
  checklist filled in. Run `npm test`, `npm run lint`, `npm run typecheck` and `npm run check:licenses` first;
  for page changes also run `npm run e2e` and attach a screenshot.
- **New dependencies:** keep them to dev tools, pin the exact version, and use only permissive licences.
  `npm run check:licenses` enforces this.
- **Written with an AI agent?** Fine. Say which agent and model, and read the whole diff yourself before
  opening the pull request.
