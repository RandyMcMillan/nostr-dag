# nostr-dag Git Viewer

The Git Viewer clones public repositories into an in-browser
[LightningFS](https://github.com/isomorphic-git/lightning-fs) filesystem using
[isomorphic-git](https://isomorphic-git.org/).  It works both on localhost
(development) and on GitHub Pages (production).

## Why a CORS proxy is required

Git hosts (GitHub, GitLab, etc.) do not send `Access-Control-Allow-Origin`
headers on their smart-HTTP endpoints (`/info/refs?service=git-upload-pack` and
`/git-upload-pack`).  Browsers block cross-origin requests that lack CORS, so
isomorphic-git cannot talk to GitHub directly from a web page.

The standard workaround is a **CORS proxy** that forwards the git request and
injects the missing headers.

## Proxy fallback chain

The viewer tries proxies in this order:

1. `http://127.0.0.1:3000/proxy/` — local server (localhost only)
2. `https://cors.isomorphic-git.org` — public fallback
3. `https://corsproxy.io/?` — second public fallback

On localhost the local proxy is usually enough.  On GitHub Pages the local
proxy is unreachable, so the viewer falls back to the public proxies.

## Local proxy endpoint

`nostr-dag-server` (started with `cargo run --bin nostr-dag-server`) exposes:

```
GET  /proxy/<upstream-url>
POST /proxy/<upstream-url>
```

It forwards the request to the upstream git host and adds:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: *
```

The proxy also forwards `Content-Type`, `Accept`, and `Git-Protocol` headers so
that git smart-HTTP POST requests work correctly.

## Cloudflare Worker reference implementation

A minimal isomorphic-git CORS proxy looks like this:

```javascript
addEventListener('fetch', e => e.respondWith(handle(e.request)))

const ok = (req,u)=>{
  const q=u.searchParams
  return req.method==='OPTIONS'||
    (req.method==='GET' && u.pathname.endsWith('/info/refs') &&
      ['git-upload-pack','git-receive-pack'].includes(q.get('service')))||
    (req.method==='POST'&&u.pathname.endsWith('git-upload-pack')  &&
      req.headers.get('content-type')=='application/x-git-upload-pack-request')||
    (req.method==='POST'&&u.pathname.endsWith('git-receive-pack') &&
      req.headers.get('content-type')=='application/x-git-receive-pack-request')
}

async function handle(req){
  const src=new URL(req.url)
  if(!ok(req,src)) return new Response('Forbidden',{status:403})

  const target='https://'+src.pathname.slice(1)+src.search

  if(req.method=='OPTIONS')
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

(From <https://gist.githubusercontent.com/RandyMcMillan/cbe978f175e69a499898a6786430040d/raw/8ea88a09dfc925cda7a83e28e92059266e7ab67b/isomorphic-git-cors-proxy.js>)

## Long-term direction: NIP-PIP decentralisation

The goal is to remove the dependency on public CORS proxies entirely.  A native
`p2p-node` peer can mirror git repos, bundle them, and publish the bundle as
NIP-PIP events (kind 39078 manifest + 39079 slices) over libp2p gossipsub.
Browsers discover these peers via Nostr presence events (kind 0) and fetch the
bundle directly, then clone from the local bundle using
`createBundleHttpClient`.

See [GIT_PROXY.md](./GIT_PROXY.md) for the full protocol specification.
