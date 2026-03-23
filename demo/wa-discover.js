/**
 * wa-discover.js — Website Avatar by AdVelocity
 * Site discovery: builds PAGE_MAP and FORM_MAP from the live DOM.
 * Runs before wa-agent.js. Exposes results on window.WebsiteAvatar.
 */

(function () {

  // ─── FILTERS ──────────────────────────────────────────────────────────────

  const SKIP_HREF = [
    /^tel:/, /^mailto:/, /^javascript:/,
    /whatsapp\.com/, /facebook\.com/, /twitter\.com/, /linkedin\.com/,
    /instagram\.com/, /youtube\.com/, /tiktok\.com/,
    /terms/, /privacy/, /cookies/, /sitemap/, /wp-login/, /wp-admin/
  ];

  const SKIP_LABELS = ['terms', 'privacy', 'cookies', 'policy', 'sitemap'];

  const SKIP_FORM_IDS    = ['adminbarsearch', 'search-form', 'searchform'];
  const SKIP_FORM_CLASSES = ['klaviyo', 'mailchimp', 'newsletter', 'search'];

  // ─── PAGE DISCOVERY ───────────────────────────────────────────────────────

  function discoverPages() {
    const found   = [];
    const seenUrls = new Set();

    const selectors = [
      'nav a', 'header a',
      '.nav a', '.navigation a', '.menu a',
      '.navbar a', '#nav a', '#menu a', '#header a'
    ];

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(a => {
        const raw  = a.getAttribute('href') || '';
        const text = a.textContent.trim();
        const url  = a.href;

        if (!text || !url)                                        return;
        if (SKIP_HREF.some(p => p.test(raw) || p.test(url)))     return;
        if (SKIP_LABELS.some(l => text.toLowerCase().includes(l))) return;
        if (raw === '#' || raw.endsWith('/#'))                    return; // hash-only anchors
        if (seenUrls.has(url))                                    return;

        seenUrls.add(url);

        // Generate keywords from label — split on whitespace, slashes, hyphens
        const words    = text.toLowerCase().split(/[\s/\-&]+/).filter(w => w.length > 1);
        const keywords = [...new Set([text.toLowerCase(), ...words])];

        found.push({ label: text, file: url, keywords });
      });
    }

    // Ensure homepage is first
    const homeIdx = found.findIndex(p =>
      p.file === window.location.origin + '/' ||
      p.file === window.location.origin      ||
      p.file.endsWith('/index.html')         ||
      p.label.toLowerCase() === 'home'       ||
      p.label.toLowerCase() === 'homepage'
    );

    if (homeIdx > 0) {
      const [home] = found.splice(homeIdx, 1);
      found.unshift(home);
    }

    // Add homepage manually if missing
    if (!found.length || !found[0].keywords.some(k => ['home','homepage'].includes(k))) {
      found.unshift({
        label:    'Homepage',
        file:     window.location.origin + '/',
        keywords: ['home', 'homepage', 'home page', 'main page', 'start']
      });
    }

    return found;
  }

  // ─── FORM DISCOVERY ───────────────────────────────────────────────────────

  function discoverForms() {
    const VALID_TAGS  = ['INPUT', 'TEXTAREA', 'SELECT'];
    const SKIP_TYPES  = ['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file'];

    // Candidate containers — real <form> tags first, then common div wrappers
    const realForms = Array.from(document.querySelectorAll('form'));
    const divForms  = realForms.length === 0
      ? Array.from(document.querySelectorAll('.contact-form, .wpcf7-form, [class*="contact-form"], [id*="contact-form"]'))
      : [];

    const candidates = [...realForms, ...divForms].filter((el, idx, arr) => {
      // Skip WordPress admin bar search
      if (SKIP_FORM_IDS.some(id => el.id === id))                             return false;
      // Skip newsletter / search forms by class
      if (SKIP_FORM_CLASSES.some(c => el.className && el.className.toLowerCase().includes(c))) return false;
      // Deduplicate — skip descendants of already-included containers
      return !arr.slice(0, idx).some(prev => prev.contains(el) || el.contains(prev));
    });

    const found = [];

    candidates.forEach((form, i) => {
      const fields = [];

      form.querySelectorAll(VALID_TAGS.join(',')).forEach(el => {
        if (SKIP_TYPES.includes(el.type))                  return;
        if (!el.id && !el.name && !el.placeholder)         return;

        const label = resolveLabel(el);

        fields.push({
          id:       el.id   || null,
          name:     el.name || null,
          label:    label,
          type:     el.type || el.tagName.toLowerCase(),
          required: el.required || el.getAttribute('aria-required') === 'true',
          value:    null
        });
      });

      if (fields.length > 0) {
        found.push({
          index:    i,
          formEl:   form,
          isCF7:    form.classList.contains('wpcf7-form'),
          fields
        });
      }
    });

    // Sort — pick the form with the most fields as the primary contact form
    found.sort((a, b) => b.fields.length - a.fields.length);

    return found;
  }

  // ─── LABEL RESOLUTION ─────────────────────────────────────────────────────
  // Tries multiple strategies to find a human-readable label for a field.

  function resolveLabel(el) {
    let label = null;

    // 1. <label for="id">
    if (el.id) {
      const l = document.querySelector(`label[for="${el.id}"]`);
      if (l) label = l.textContent.trim();
    }

    // 2. Wrapping <label>
    if (!label) {
      const parentLabel = el.closest('label');
      if (parentLabel) label = parentLabel.textContent.replace(el.value || '', '').trim();
    }

    // 3. aria-label
    if (!label && el.getAttribute('aria-label')) {
      label = el.getAttribute('aria-label');
    }

    // 4. Floating label — sibling span after the input (Pod Digital / CF7 pattern)
    if (!label && el.nextElementSibling) {
      const next = el.nextElementSibling;
      if (next.classList && next.classList.contains('floating-label')) {
        label = next.textContent.trim();
      }
    }

    // 5. wpcf7 — parent label text node
    if (!label && el.closest('.wpcf7-form-control-wrap')) {
      const wrap        = el.closest('.wpcf7-form-control-wrap');
      const parentLabel = wrap.closest('label');
      if (parentLabel) {
        const text = Array.from(parentLabel.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim())
          .filter(Boolean)
          .join(' ');
        if (text) label = text;
      }
    }

    // 6. Preceding sibling text element
    if (!label && el.previousElementSibling) {
      const prev = el.previousElementSibling;
      if (['LABEL','SPAN','P','DIV'].includes(prev.tagName)) {
        label = prev.textContent.trim();
      }
    }

    // 7. Placeholder or name fallback
    if (!label) label = el.placeholder || el.name || el.id || 'Field';

    // Clean up — remove trailing colons, asterisks, extra whitespace
    return label.replace(/[*:\s]+$/, '').trim();
  }

  // ─── CF7 EVENT LISTENERS ──────────────────────────────────────────────────
  // Register early so they're ready before any form interaction.

  function registerCF7Listeners() {
    document.addEventListener('wpcf7mailsent', e => {
      window.WebsiteAvatar.bus.emit('form:submitted', { detail: e.detail });
    });
    document.addEventListener('wpcf7invalid', e => {
      window.WebsiteAvatar.bus.emit('form:invalid', { detail: e.detail });
    });
    document.addEventListener('wpcf7spam', e => {
      window.WebsiteAvatar.bus.emit('form:spam', { detail: e.detail });
    });
    document.addEventListener('wpcf7mailfailed', e => {
      window.WebsiteAvatar.bus.emit('form:failed', { detail: e.detail });
    });
  }

  // ─── RUN ──────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    // Ensure namespace exists
    window.WebsiteAvatar = window.WebsiteAvatar || {};

    // Simple event bus for cross-script communication
    if (!window.WebsiteAvatar.bus) {
      const listeners = {};
      window.WebsiteAvatar.bus = {
        on:   (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); },
        off:  (event, fn) => { listeners[event] = (listeners[event] || []).filter(f => f !== fn); },
        emit: (event, data) => { (listeners[event] || []).forEach(fn => fn(data)); }
      };
    }

    const pageMap = discoverPages();
    const formMap = discoverForms();

    window.WebsiteAvatar.PAGE_MAP = pageMap;
    window.WebsiteAvatar.FORM_MAP = formMap;

    // Legacy globals for backward compat during transition
    window.PAGE_MAP = pageMap;
    window.FORM_MAP = formMap;

    registerCF7Listeners();

    if (window.WebsiteAvatar.DEBUG) {
      console.group('[WA] 🔍 Site discovery — ' + window.location.hostname);
      console.group(`[WA] 📄 Pages (${pageMap.length})`);
      pageMap.forEach(p => console.log(`  "${p.label}" → ${p.file}`));
      console.groupEnd();
      console.group(`[WA] 📋 Forms (${formMap.length})`);
      formMap.forEach(f => {
        console.group(`  Form ${f.index}${f.isCF7 ? ' [CF7]' : ''}${f.formEl.id ? ' #' + f.formEl.id : ''}`);
        f.fields.forEach(field => {
          const id = field.id ? `id=${field.id}` : `name=${field.name}`;
          console.log(`    ${id} → "${field.label}"${field.required ? ' *' : ''}`);
        });
        console.groupEnd();
      });
      console.groupEnd();
      console.groupEnd();
    }
  });

})();
