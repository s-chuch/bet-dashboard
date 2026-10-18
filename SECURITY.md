# Security Policy

## Reporting a vulnerability

Please report privately using GitHub's **private vulnerability reporting**:
repository **Security** tab -> **Report a vulnerability**. Do not open a public issue for security problems.

## What is public (by design)

This repository and its GitHub Pages site are public. Everything committed here is world-readable, including
bets, stakes, results, P&L, ledger entries and book balances (`data/`, `data.json`, `stats.json`, `archive.json`,
`log.json`). Do not treat that data as confidential, and do not commit anything you would not publish.

## Credentials

No credentials, API keys or personal accounts are stored in the repository. The automation runs on GitHub Actions
with the built-in short-lived `GITHUB_TOKEN` only (contents: write, pages: write), and fetches public ESPN data.
CI scans tracked files for common token and private-key patterns.

## Scope

In scope: the workflows in `.github/`, the scripts in `scripts/`, and the static pages. Out of scope: the
public nature of the data above, and GitHub Pages platform limits (it cannot send custom HTTP headers).
