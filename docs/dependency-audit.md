# Dependency audit (production dependencies)

`npm audit --omit=dev`, 6 October 2026: 5 advisories (1 critical, 1 high, 3 moderate), in
two packages. Nothing was changed to silence them. This is a record of what they are and
why they do or do not reach what OpennJob runs, not a security review.

## next 14.2.35 (and its own copy of postcss)

14.2.35 is the newest 14.2 release. `npm audit fix --force` would move to Next 16, a
breaking change that has not been made or tested.

The advisories listed are in server features: server actions, the image optimisation API,
rewrites, middleware, response caching, and running on a Windows server. OpennJob's web app
is built with `output: 'export'` into static files (`apps/web/out`) and served by a plain
file server or a CDN. No Next.js server runs in production, so none of those code paths
runs. The postcss advisories concern processing untrusted CSS at build time; the only CSS
built is the app's own.

**Still to do:** move to a supported major version of Next.js before a public launch, and
re-check this file then. The reasoning above was not checked by anyone else.

## mammoth 1.13 (sprintf-js through argparse)

`mammoth` reads Word files for CV upload. It depends on `argparse`, which depends on
`sprintf-js`; `argparse` is used only by mammoth's command-line tool. The API calls
`mammoth.extractRawText` from the library and never loads the command-line entry point, so
the vulnerable formatting code is not on the upload path. The advisory is a denial of
service through unbounded precision specifiers in format strings, which the API never
builds from user input. `npm audit fix --force` would install mammoth 0.3.29, a much older
release; that was not done.

## Development-only dependencies

`npm audit` without `--omit=dev` also lists advisories in test tooling. They do not ship.
