/**
 * wa-discover.js — Website Avatar by AdVelocity
 * Site discovery: builds PAGE_MAP and FORM_MAP from the live DOM.
 * Runs before wa-agent.js. Exposes results on window.WebsiteAvatar.
 */

(function () {

  // ─── NAMESPACE ────────────────────────────────────────────────────────────
  window.WebsiteAvatar = window.WebsiteAvatar || {};
  window.WebsiteAvatar.DEBUG = window.WA_CONFIG?.debug || false;
  const DEBUG = window.WebsiteAvatar.DEBUG; // fix for log/warn
  const WA = window.WebsiteAvatar;

  function log(...args)  { if (DEBUG) console.log('[WA:Discover]', ...args); }
  function warn(...args) { if (DEBUG) console.warn('[WA:Discover]', ...args); }

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
    const found = [];
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

        if (!text || !url) return;
        if (SKIP_HREF.some(p => p.test(raw) || p.test(url))) return;
        if (SKIP_LABELS.some(l => text.toLowerCase().includes(l))) return;
        if (raw === '#' || raw.endsWith('/#')) return;
        if (seenUrls.has(url)) return;

        seenUrls.add(url);

        const words    = text.toLowerCase().split(/[\s/\-&]+/).filter(w => w.length > 1);
        const keywords = [...new Set([text.toLowerCase(), ...words])];

        found.push({ label: text, file: url, keywords });
      });
    }

    // Ensure homepage first
    const homeIdx = found.findIndex(p =>
      p.file === window.location.origin + '/' ||
      p.file === window.location.origin ||
      p.file.endsWith('/index.html') ||
      p.label.toLowerCase() === 'home' ||
      p.label.toLowerCase() === 'homepage'
    );

    if (homeIdx > 0) {
      const [home] = found.splice(homeIdx, 1);
      found.unshift(home);
    }

    if (!found.length || !found[0].keywords.some(k => ['home','homepage'].includes(k))) {
      found.unshift({
        label: 'Homepage',
        file: window.location.origin + '/',
        keywords: ['home', 'homepage', 'home page', 'main page', 'start']
      });
    }

    return found;
  }

  // ─── FORM DISCOVERY ───────────────────────────────────────────────────────
  function discoverForms() {
    const VALID_TAGS  = ['INPUT', 'TEXTAREA', 'SELECT'];
    const SKIP_TYPES  = ['hidden', 'submit', 'button', 'reset', 'image', 'file'];

    const realForms = Array.from(document.querySelectorAll('form'));
    const divForms  = realForms.length === 0
      ? Array.from(document.querySelectorAll('.contact-form, .wpcf7-form, [class*="contact-form"], [id*="contact-form"]'))
      : [];

    const candidates = [...realForms, ...divForms].filter((el, idx, arr) => {
      if (SKIP_FORM_IDS.some(id => el.id === id)) return false;
      if (SKIP_FORM_CLASSES.some(c => el.className && el.className.toLowerCase().includes(c))) return false;
      return !arr.slice(0, idx).some(prev => prev.contains(el) || el.contains(prev));
    });

    const found = [];

    candidates.forEach((form, i) => {
      const fields     = [];
      const seenGroups = new Set(); // track checkbox/radio groups by name

      // Use DOM order — querySelectorAll returns elements in document order
      form.querySelectorAll(VALID_TAGS.join(',')).forEach(el => {
        const type = el.type || el.tagName.toLowerCase();

        // ── Checkbox / Radio groups ──────────────────────────────────────────
        if (type === 'checkbox' || type === 'radio') {
          const groupName = el.name ? el.name.replace(/\[\]$/, '') : null;
          if (!groupName) return;
          if (seenGroups.has(groupName)) return; // already processed this group
          seenGroups.add(groupName);

          // Collect all options in this group
          const groupEls = Array.from(
            form.querySelectorAll(`input[type="${type}"][name="${el.name}"], input[type="${type}"][name="${groupName}[]"]`)
          );
          if (!groupEls.length) return;

          const options = groupEls.map(opt => {
            // Try to get label from parent label element
            const parentLabel = opt.closest('label');
            const optLabel = parentLabel
              ? parentLabel.textContent.trim()
              : (opt.nextElementSibling?.textContent?.trim() || opt.value);
            return { value: opt.value, label: optLabel };
          });

          // Group label — look for a label preceding the group
          const wrap = el.closest('.wpcf7-form-control-wrap') || el.closest('fieldset') || el.parentElement;
          let groupLabel = null;
          if (wrap) {
            const prev = wrap.previousElementSibling;
            if (prev) groupLabel = prev.textContent.trim();
            if (!groupLabel) {
              const parentEl = wrap.parentElement;
              if (parentEl) {
                const labelEl = parentEl.querySelector('label');
                if (labelEl) groupLabel = labelEl.textContent.trim();
              }
            }
          }
          if (!groupLabel) groupLabel = groupName.replace(/[-_]/g, ' ');

          fields.push({
            id:       null,
            name:     groupName,
            label:    groupLabel.replace(/[*:\s]+$/, '').trim(),
            type:     type === 'radio' ? 'radio' : 'checkbox',
            required: el.required || el.getAttribute('aria-required') === 'true',
            options,          // array of { value, label }
            value:    null    // will be array of selected values
          });
          return;
        }

        // ── Standard fields ──────────────────────────────────────────────────
        if (SKIP_TYPES.includes(type)) return;
        if (!el.id && !el.name && !el.placeholder) return;

        const label = resolveLabel(el);

        // Handle SELECT options
        let options = null;
        if (el.tagName === 'SELECT') {
          options = Array.from(el.options)
            .filter(o => o.value)
            .map(o => ({ value: o.value, label: o.text.trim() }));
        }

        fields.push({
          id:       el.id || null,
          name:     el.name || null,
          label,
          type:     type,
          required: el.required || el.getAttribute('aria-required') === 'true',
          options,
          value:    null
        });
      });

      if (fields.length > 0) {
        found.push({
          index: i,
          formEl: form,
          isCF7:  form.classList.contains('wpcf7-form'),
          fields
        });
      }
    });

    found.sort((a, b) => b.fields.length - a.fields.length);
    return found;
  }

  // ─── LABEL RESOLUTION ─────────────────────────────────────────────────────
  function resolveLabel(el) {
    let label = null;

    if (el.id) {
      const l = document.querySelector(`label[for="${el.id}"]`);
      if (l) label = l.textContent.trim();
    }
    if (!label) {
      const parentLabel = el.closest('label');
      if (parentLabel) label = parentLabel.textContent.replace(el.value || '', '').trim();
    }
    if (!label && el.getAttribute('aria-label')) label = el.getAttribute('aria-label');
    if (!label && el.nextElementSibling?.classList?.contains('floating-label')) label = el.nextElementSibling.textContent.trim();
    if (!label && el.closest('.wpcf7-form-control-wrap')) {
      const wrap = el.closest('.wpcf7-form-control-wrap');
      const pl = wrap.closest('label');
      if (pl) label = Array.from(pl.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim())
        .filter(Boolean)
        .join(' ');
    }
    if (!label && el.previousElementSibling) {
      const prev = el.previousElementSibling;
      if (['LABEL','SPAN','P','DIV'].includes(prev.tagName)) label = prev.textContent.trim();
    }

    if (!label) label = el.placeholder || el.name || el.id || 'Field';
    return label.replace(/[*:\s]+$/, '').trim();
  }

  // ─── PAGE CONTEXT ─────────────────────────────────────────────────────────
  // Builds a semantic inventory of actionable elements on the current page.
  // Used by wa-agent.js to give the AI structured context about what it can do.
  // Elements get stable synthetic IDs (wa_el_N) — independent of DOM IDs.

  function buildPageContext() {
    const elements = [];
    let idx = 0;
    const seen = new Set(); // deduplicate by text+type

    function addEl(el) {
      const key = el.type + ':' + (el.text || el.title || '');
      if (seen.has(key)) return;
      seen.add(key);
      elements.push({ id: `wa_el_${idx++}`, ...el });
    }

    // ── CTAs — buttons and prominent links ──────────────────────────────────
    // Skip common cookie/consent/newsletter words and generic UI labels
    const CTA_SKIP_WORDS = /^(menu|nav|close|open|toggle|search|submit|send|next|prev|back|more|less|show|hide|expand|collapse|\d+|customise|customize|accept|accept all|reject|reject all|save my preferences|necessary|functional|analytics|performance|advertisement|uncategorised|uncategorized|subscribe|sign up|newsletter|manage|manage cookies|manage preferences|cookie|privacy|i agree|agree|decline|got it|ok|okay)$/i;

    // Skip containers that are cookie banners, popups, or newsletter widgets
    const SKIP_CONTAINERS = [
      '[class*="cookie"]', '[class*="consent"]', '[class*="gdpr"]',
      '[class*="privacy"]', '[id*="cookie"]', '[id*="consent"]',
      '[id*="gdpr"]', '[class*="newsletter"]', '[class*="popup"]',
      '[class*="modal"]:not(.wa-)', '[role="dialog"]', '[aria-modal]'
    ].join(', ');

    const CTA_SELECTORS = 'a.btn, a.button, a[class*="btn"], a[class*="button"], button:not([type="submit"]):not([type="reset"]):not(.wa-), input[type="button"]';

    document.querySelectorAll(CTA_SELECTORS).forEach(el => {
      const text = el.textContent.trim().replace(/\s+/g, ' ');
      if (!text || text.length < 3 || text.length > 60) return;
      if (CTA_SKIP_WORDS.test(text)) return;
      // Skip if inside our widget, a cookie banner, or other skip containers
      if (el.closest('#wa-panel, #wa-bubble')) return;
      if (el.closest(SKIP_CONTAINERS)) return;

      addEl({
        type:    'button',
        text,
        role:    'cta',
        actions: ['click'],
        _el:     el
      });
    });

    // ── Sections — named page sections the user might want to scroll to ─────
    const SECTION_TAGS = 'h2, h3, [class*="section-title"], [class*="heading"]';
    document.querySelectorAll(SECTION_TAGS).forEach(el => {
      const text = el.textContent.trim().replace(/\s+/g, ' ');
      if (!text || text.length < 3 || text.length > 80) return;
      if (el.closest('#wa-panel, #wa-bubble, nav, header, footer')) return;
      if (el.closest(SKIP_CONTAINERS)) return;

      // Find the scrollable parent section
      const section = el.closest('section, article, div[id], div[class]') || el.parentElement;

      addEl({
        type:    'section',
        title:   text,
        role:    'content_section',
        actions: ['scroll'],
        _el:     section || el
      });
    });

    // ── Phone numbers — click to call ────────────────────────────────────────
    document.querySelectorAll('a[href^="tel:"]').forEach(el => {
      const number = el.href.replace('tel:', '').trim();
      const label  = el.textContent.trim() || number;
      addEl({
        type:    'phone',
        text:    label,
        number,
        role:    'contact',
        actions: ['click', 'highlight'],
        _el:     el
      });
    });

    // ── Email addresses — click to email ─────────────────────────────────────
    document.querySelectorAll('a[href^="mailto:"]').forEach(el => {
      const email = el.href.replace('mailto:', '').trim();
      const label = el.textContent.trim() || email;
      addEl({
        type:    'email',
        text:    label,
        email,
        role:    'contact',
        actions: ['highlight'],
        _el:     el
      });
    });

    // ── Videos ───────────────────────────────────────────────────────────────
    document.querySelectorAll('video, iframe[src*="youtube"], iframe[src*="vimeo"], [class*="video"]').forEach(el => {
      const title = el.getAttribute('title') || el.getAttribute('aria-label') || 'Video';
      addEl({
        type:    'video',
        title,
        role:    'media',
        actions: ['scroll', 'highlight'],
        _el:     el
      });
    });

    // Remove _el before serialising — only used internally for execution
    const serialisable = elements.map(({ _el, ...rest }) => rest);

    return {
      page:     document.title,
      url:      window.location.href,
      elements: serialisable,
      // Keep _el references separately for action execution
      _refs:    elements.reduce((acc, el) => { acc[el.id] = el._el; return acc; }, {})
    };
  }

  // ─── CF7 EVENT LISTENERS ──────────────────────────────────────────────────
  function registerCF7Listeners() {
    document.addEventListener('wpcf7mailsent', e => WA.bus.emit('form:submitted', { detail: e.detail }));
    document.addEventListener('wpcf7invalid', e => WA.bus.emit('form:invalid', { detail: e.detail }));
    document.addEventListener('wpcf7spam', e => WA.bus.emit('form:spam', { detail: e.detail }));
    document.addEventListener('wpcf7mailfailed', e => WA.bus.emit('form:failed', { detail: e.detail }));
  }

  // ─── EVENT BUS ────────────────────────────────────────────────────────────
  if (!WA.bus) {
    const listeners = {};
    WA.bus = {
      on: (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); },
      off: (evt, fn) => { listeners[evt] = (listeners[evt] || []).filter(f => f !== fn); },
      emit: (evt, data) => { (listeners[evt] || []).forEach(f => f(data)); }
    };
  }

  // ─── INITIALISATION ───────────────────────────────────────────────────────
  function initDiscovery() {
    WA.PAGE_MAP     = discoverPages();
    WA.FORM_MAP     = discoverForms();
    WA.PAGE_CONTEXT = buildPageContext();
    registerCF7Listeners();

    if (DEBUG) {
      console.group(`[WA] 🔍 Site discovery — ${window.location.hostname}`);
      console.group(`[WA] 📄 Pages (${WA.PAGE_MAP.length})`);
      WA.PAGE_MAP.forEach(p => console.log(`  "${p.label}" → ${p.file}`));
      console.groupEnd();
      if (WA.PAGE_CONTEXT?.elements?.length) {
        console.group(`[WA] 🎯 Page elements (${WA.PAGE_CONTEXT.elements.length})`);
        WA.PAGE_CONTEXT.elements.forEach(e => {
          const desc = e.text || e.title || e.number || e.email || '';
          console.log(`    ${e.id} [${e.type}] "${desc}" → ${e.actions.join(', ')}`);
        });
        console.groupEnd();
      }
      console.group(`[WA] 📋 Forms (${WA.FORM_MAP.length})`);
      WA.FORM_MAP.forEach(f => {
        console.group(`  Form ${f.index}${f.isCF7 ? ' [CF7]' : ''}${f.formEl.id ? ' #' + f.formEl.id : ''}`);
        f.fields.forEach(field => {
          const id = field.id ? `id=${field.id}` : `name=${field.name}`;
          const opts = field.options?.length ? ` [${field.options.map(o => o.value).join(', ')}]` : '';
          console.log(`    ${id} → "${field.label}"${field.required ? ' *' : ''} (${field.type})${opts}`);
        });
        console.groupEnd();
      });
      console.groupEnd();
      console.groupEnd();
    }
  }

  // ─── RUN ──────────────────────────────────────────────────────────────────
  function runDiscovery() {
    if (WA._discoveryDone) return;
    WA._discoveryDone = true;
    initDiscovery();
  }

  // Run once on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runDiscovery);
  } else {
    runDiscovery();
  }

})();