function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Render the shared page header and navigation bar used by the demo and Git viewer.
 * Keep the page-specific content below this shared chrome so both entry points stay aligned.
 */
export function createSharedHeader(root, options = {}) {
  if (!root) {
    return {
      render() {},
      setNetworkTime() {},
    };
  }

  const title = options.title || 'nostr-dag';
  const subtitleHtml = options.subtitleHtml || '';
  const logoHref = options.logoHref || '#';
  const iconHref = options.iconHref || './shared/favicon.ico';
  const navItems = Array.isArray(options.navItems) ? options.navItems : [];

  root.classList.add('sticky-header');
  root.innerHTML = `
    <div class="header-container">
      <nav class="header-nav" aria-label="Primary navigation">
        <div class="header-brand">
          <a href="${escapeHtml(logoHref)}"><img class="brand-icon" src="${escapeHtml(iconHref)}" alt="" aria-hidden="true" /><span class="logo-text">${escapeHtml(title)}</span></a>
          ${subtitleHtml ? `<div class="muted header-subtitle">${subtitleHtml}</div>` : ''}
        </div>
        <div class="header-actions">
          ${navItems.length ? `
            <ul class="nav-links">
              ${navItems
                .map((item) => {
                  const label = escapeHtml(item.label || '');
                  const href = escapeHtml(item.href || '#');
                  const current = item.current ? ' aria-current="page"' : '';
                  return `<li><a class="nav-link${item.current ? ' current' : ''}" href="${href}"${current}>${label}</a></li>`;
                })
                .join('')}
            </ul>
          ` : ''}
        </div>
      </nav>
    </div>
    <!-- Network time sub-header: rendered asynchronously, initially hidden until first update -->
    <div class="header-subbar header-subbar--hidden" data-network-time role="status" aria-live="polite" title="Network time syncing">
      <span class="header-subbar-label">network time</span>
      <span class="header-subbar-value" data-network-time-value>syncing…</span>
      <span class="header-subbar-status" data-network-time-status></span>
    </div>
  `;

  const networkTimeEl = typeof root.querySelector === 'function'
    ? root.querySelector('[data-network-time]')
    : null;
  const networkTimeValueEl = typeof root.querySelector === 'function'
    ? root.querySelector('[data-network-time-value]')
    : null;
  const networkTimeStatusEl = typeof root.querySelector === 'function'
    ? root.querySelector('[data-network-time-status]')
    : null;

  return {
    render() {},
    setNetworkTime({ text = 'syncing…', title = 'Network time syncing', state = 'checking' } = {}) {
      if (!networkTimeEl || !networkTimeValueEl) return;
      // Async non-blocking reveal: schedule via requestAnimationFrame so the
      // main nav paints first, then the sub-header fades in on first real update.
      const update = () => {
        networkTimeEl.className = `header-subbar status-${state}`;
        networkTimeEl.title = title;
        networkTimeValueEl.textContent = text;
        if (networkTimeStatusEl) networkTimeStatusEl.textContent = state === 'checking' ? '⟳' : state === 'available' ? '✓' : '✗';
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(update);
      } else {
        update();
      }
    },
  };
}
