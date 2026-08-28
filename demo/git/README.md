# Git Viewer — Server Dependencies

## What isomorphic-git Needs from Servers

### The Core Problem: CORS

Git hosts (GitHub, GitLab, Bitbucket) do **not** send `Access-Control-Allow-Origin` headers. Browsers block cross-origin git requests. `isomorphic-git` solves this with a **CORS proxy**.

### What a CORS Proxy Must Do

1. Receive the browser's request
2. Forward it to the actual git host
3. Add CORS headers to the response (`Access-Control-Allow-Origin: *`)
4. Stream the response back

### URL Format

`isomorphic-git` transforms the repo URL through the proxy:

```js
// Path-style (what we use)
https://cors.isomorphic-git.org/https://github.com/user/repo

// Query-string style (also supported)
https://proxy.example.com/proxy.php?https://github.com/user/repo
```

### Git HTTP Endpoints the Proxy Must Forward

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/info/refs?service=git-upload-pack` | Discover refs for cloning/fetching |
| `POST` | `/git-upload-pack` | Download packfile (actual clone/fetch) |
| `GET` | `/info/refs?service=git-receive-pack` | Discover refs for pushing |
| `POST` | `/git-receive-pack` | Upload packfile (push) |

### Current Setup

We use `https://cors.isomorphic-git.org` — a free community proxy sponsored by Clever Cloud. It can be slow, rate-limited, or down.

### Self-Hosting Options

- **`@isomorphic-git/cors-proxy`** — npm package you can run locally
- **CloudFlare Workers** — serverless proxy ([setup gist](https://gist.github.com/tomlarkworthy/cf1d4ceabeabdb6d1628575ab3a83acf))
- **Gogs / Gitea** — self-hosted git servers that already send CORS headers (no proxy needed)
- **Azure DevOps** — supports CORS with authentication

GitHub, GitLab, and Bitbucket **do not** support CORS natively.
