import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

const bundles = [
  {
    entry: resolve(root, 'vendor-src/nostr-tools.mjs'),
    outfile: resolve(root, 'demo/vendor/nostr-tools.mjs'),
  },
  {
    entry: resolve(root, 'vendor-src/isomorphic-git.mjs'),
    outfile: resolve(root, 'demo/vendor/isomorphic-git.mjs'),
  },
  {
    entry: resolve(root, 'vendor-src/isomorphic-git-http-web.mjs'),
    outfile: resolve(root, 'demo/vendor/isomorphic-git-http-web.mjs'),
  },
  {
    entry: resolve(root, 'vendor-src/lightning-fs.mjs'),
    outfile: resolve(root, 'demo/vendor/lightning-fs.mjs'),
  },
  {
    entry: resolve(root, 'demo/shared/libp2p-stack.mjs'),
    outfile: resolve(root, 'demo/vendor/libp2p-stack.mjs'),
  },
];

for (const bundle of bundles) {
  await mkdir(dirname(bundle.outfile), { recursive: true });
  await build({
    entryPoints: [bundle.entry],
    outfile: bundle.outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2020'],
    sourcemap: false,
    minify: false,
    legalComments: 'none',
  });
}
