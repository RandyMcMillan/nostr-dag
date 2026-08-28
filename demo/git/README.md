# Git Viewer — Why Decentralized Git Matters

## The Problem

Git is decentralized by design — every clone is a full copy. Yet in practice, git hosting is **heavily centralized** around a handful of platforms (GitHub, GitLab, Bitbucket). When these platforms block, rate-limit, or go down, access to code disappears.

For browser-based git tools like `isomorphic-git`, the problem is worse:

1. **CORS Lockout** — Browsers enforce same-origin policy. GitHub/GitLab do not send `Access-Control-Allow-Origin` headers, so browsers cannot talk to them directly.
2. **Proxy Dependency** — `isomorphic-git` relies on a centralized CORS proxy (`cors.isomorphic-git.org`). When that proxy is blocked (Cloudflare 403) or down, cloning stops working entirely.
3. **Single Point of Failure** — One proxy serves all users. Rate limits, outages, or censorship affect everyone.
4. **No Peer Redundancy** — If GitHub blocks a repo or region, there is no automatic fallback to mirrors or peers.

## Why Decentralized Git

- **Censorship Resistance** — Code should remain accessible even if a platform removes it.
- **Offline-First** — Peers can share bundles without internet access to the original host.
- **Redundancy** — Any peer with a clone becomes a mirror. No single server is critical.
- **Protocol Agnostic** — Git over HTTP, SSH, or peer-to-peer should all work.

## What isomorphic-git Needs from Servers

### CORS Proxy Basics

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

**Current GH Pages failure:** `cors.isomorphic-git.org` returns HTTP 403 (blocked by Cloudflare), so `https://randymcmillan.github.io/nostr-dag/git/?repo=nostr-dag&branch=master` cannot clone repos.

### Self-Hosting Options

- **`@isomorphic-git/cors-proxy`** — npm package you can run locally
- **CloudFlare Workers** — serverless proxy ([setup gist](https://gist.github.com/tomlarkworthy/cf1d4ceabeabdb6d1628575ab3a83acf))
- **Gogs / Gitea** — self-hosted git servers that already send CORS headers (no proxy needed)
- **Azure DevOps** — supports CORS with authentication

GitHub, GitLab, and Bitbucket **do not** support CORS natively.

### CloudFlare Worker CORS Proxy (from gist)

```js
addEventListener('fetch', e => e.respondWith(handle(e.request)))

const ok = (req,u)=>{
  const q=u.searchParams
  return req.method==='OPTIONS'||
    (req.method==='GET' && u.pathname.endsWith('/info/refs') &&
      ['git-upload-pack','git-receive-pack'].includes(q.get('service')))||
    (req.method==='POST'&&u.pathname.endsWith('git-upload-pack')  &&
      req.headers.get('content-type')==='application/x-git-upload-pack-request')||
    (req.method==='POST'&&u.pathname.endsWith('git-receive-pack') &&
      req.headers.get('content-type')==='application/x-git-receive-pack-request')
}

async function handle(req){
  const src=new URL(req.url)
  if(!ok(req,src)) return new Response('Forbidden',{status:403})

  const target='https://'+src.pathname.slice(1)+src.search   // drop leading "/"

  if(req.method==='OPTIONS')
    return new Response(null,{status:200,headers:cors(req)})

  const resp=await fetch(target,{
    method:req.method,
    headers:strip(req.headers),
    body:req.body,
    redirect:'follow'
  })
  return new Response(resp.body,{
    status:resp.status,
    headers:merge(resp.headers,cors(req))
  })
}

const cors=req=>{
  const hdr=req.headers
  return {
    'Access-Control-Allow-Origin': hdr.get('Origin')||'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': hdr.get('Access-Control-Request-Headers')||'*',
    'Vary':'Origin'
  }
}

const strip=h=>{
  const out=new Headers(h)
  ;['host','origin','referer','content-length'].forEach(k=>out.delete(k))
  return out
}
const merge=(h,x)=>{const o=new Headers(h);for(const[k,v]of Object.entries(x))o.set(k,v);return o}
```

## Our Approach: NIP-PIP + libp2p

Instead of relying on centralized CORS proxies, we use:

- **NIP-PIP** — Packetized Information Protocol over Nostr/libp2p for transferring git bundles
- **Native peer (`p2p-node.rs`)** — Maintains local clones and advertises bundles as PIP manifests
- **Browser libp2p stack** — Discovers peers, requests bundles, and reconstructs them in LightningFS
- **isomorphic-git** — Reads from LightningFS once the bundle is available

See [GIT_PROXY.md](./GIT_PROXY.md) for the implementation plan.
