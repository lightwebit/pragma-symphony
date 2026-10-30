# Security Policy

## Supported versions

Only the latest version receives security fixes.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Send a report to **lightweb.it@gmail.com** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof of concept
- The version or commit affected

You can expect an acknowledgement within 72 hours and a status update within 7 days.

## Scope

In scope: anything in this repository — the Tauri backend (`src-tauri/`), the parser crate (`pragma-parser/`), the CLI wrapper (`pragma-cli/`) and the Vue frontend (`src/`), including the web bridge in `src/remote/`. The hosted relay on noema.tools is also in scope, even though its code is not here.

Out of scope: vulnerabilities in Claude Code itself, in Tauri, or in other upstream dependencies. Report those to their maintainers.

## By design

Pragma runs Claude Code with `--dangerously-skip-permissions`, and stores its data unencrypted in `~/.pragma/`, restricted to the user account. Both are documented in the [README](README.md#what-you-should-know-before-using-it) and are not vulnerabilities in themselves. A way to escape them, or to reach them from outside, is.

## Disclosure policy

Once a fix is ready, the vulnerability is disclosed in `CHANGELOG.md` under a **Security** section. Credit goes to the reporter unless they prefer to stay anonymous.
