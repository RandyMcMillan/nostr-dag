import assert from 'node:assert/strict';
import test from 'node:test';

test('shared header renders nav and active state', async () => {
  const { createSharedHeader } = await import(new URL(`../demo/shared/page-header.mjs?test=${Date.now()}`, import.meta.url));
  const root = {
    className: '',
    classList: {
      add(name) {
        root.className = root.className ? `${root.className} ${name}` : name;
      },
    },
    innerHTML: '',
  };

  createSharedHeader(root, {
    title: 'nostr-dag',
    logoHref: './',
    subtitleHtml: 'Shared chrome',
    navItems: [
      { label: 'Demo', href: './', current: true },
      { label: 'Git viewer', href: './git/' },
    ],
  });

  assert.match(root.className, /sticky-header/);
  assert.match(root.innerHTML, /header-container/);
  assert.match(root.innerHTML, /nav-links/);
  assert.match(root.innerHTML, /network time/i);
  assert.match(root.innerHTML, /href="\.\//);
  assert.match(root.innerHTML, /aria-current="page"/);
  assert.match(root.innerHTML, /Git viewer/);
});
