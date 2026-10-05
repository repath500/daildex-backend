# Contributing

Use Node 22 and `npm ci`. Run `npm run verify` before opening a pull request.
Tests that need PostgreSQL belong in `*.integration.test.ts` and should use a
separate disposable database. Never include real subscriber information, private
chats, credentials or provider response logs in a patch or issue.

This repository is the backend release of the DáilDex monorepo. Contributions
here can be incorporated into the hosted service. Keep backend packages usable
without the private website. When changing record attribution, include the
original Oireachtas source and an example demonstrating the change.

By submitting code, you agree to make your contribution available under the
repository's MIT licence. Public discussions and code reviews should stay
respectful and focused on the change.
