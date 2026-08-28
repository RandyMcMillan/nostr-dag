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

### CloudFlare Worker CORS Proxy

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
