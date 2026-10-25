# Repo Archive artifact diagnostic

This is **not a working solver**. The local challenge accepts a GitHub response
whose `Content-Type` starts with the single byte `85` (hex) followed by
`application/json`, but no real GitHub artifact with that response has been
produced yet. A UTF-8 `\u0085` encoded as `c2 85` does **not** work.

The manually triggered workflow probes two unverified ways to produce that
response through GitHub Actions artifacts:

1. Send a raw, invalid UTF-8 byte `85` in the protobuf `mime_type` field for
   artifact versions 6 and 7.
2. Create version 6 and 7 artifacts with names that differ only by case,
   Unicode normalization, a trailing dot, or a trailing space. Each ordering
   is tried once. This checks whether name lookup mixes the version and MIME
   metadata.

The script makes **18** `CreateArtifact` requests at most. It uploads a small
placeholder to each accepted artifact, then logs only status codes, artifact
IDs, response MIME hex, and a short error category. It never prints the
GitHub Actions runtime token or signed Azure URLs. It uploads the JSON carrier
containing `file:///proc/self/environ` **only if** the final HTTP response
actually starts with the single header byte `85`; it then downloads the blob
again and checks that its body matches.

## External action required to run it

Running this requires creating a disposable **public personal GitHub
repository** containing this directory, enabling GitHub Actions, and manually
dispatching `.github/workflows/probe.yml`. The workflow's `GITHUB_TOKEN` needs
`actions: write`; `workflow_dispatch` is its only trigger. This would create
public artifacts and consume Actions minutes. No repository or workflow has
been created or run by this diagnostic work.

Even a `WINNER` line would only prove the artifact response is suitable. The
challenge instancer requests OAuth `public_repo`, while [GitHub's artifact
download REST documentation](https://docs.github.com/en/rest/actions/artifacts#download-an-artifact)
lists the broader `repo` scope for classic OAuth tokens. Whether the
instancer's token can fetch a public artifact remains **unverified and may
block the remote chain**. Do not grant additional GitHub permissions on the
strength of this probe alone.

## Local checks

From this directory, `node --check probe.mjs` checks syntax without making
requests. `npm ci --ignore-scripts --no-audit --no-fund` installs the pinned
dependencies locally. The probe exits immediately outside GitHub Actions
because the runtime environment variables are absent.
