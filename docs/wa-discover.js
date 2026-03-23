/**
 * wa-discover.js — Website Avatar by AdVelocity
 * Site discovery: builds PAGE_MAP and FORM_MAP from the live DOM.
 * Runs before wa-agent.js. Exposes results on window.WebsiteAvatar.
 */

(function () {

  // ─── NAMESPACE & CONFIG ────────────────────────────────────────────────────
  window.WebsiteAvatar = window.WebsiteAvatar || {};
  const WA     = window.WebsiteAvatar;
  const CONFIG = window.WA_CONFIG || {};
  const DEBUG  = CONFIG.debug || false;

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
    const found   = [];
    const seenUrls = new Set();
    const selectors = [
      'nav a', 'header a',
      '.nav a', '.navigation a', '.menu a',
      '.navbar a', '#nav a', '#menu a', '#header a'
    ];

    selectors.forEach(sel => {
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
    });

    // Ensure homepage first
    const homeIdx = found.findIndex(p =>
      p.file === window.location.origin + '/' ||
      p.file === window.location.origin ||
      p.file.endsWith('/index.html') ||
      ['home', 'homepage'].includes(p.label.toLowerCase())
    );

    if (homeIdx > 0) {
      const [home] = found.splice(homeIdx, 1);
      found.unshift(home);
    }

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
      const fields = [];
      form.querySelectorAll(VALID_TAGS.join(',')).forEach(el => {
        if (SKIP_TYPES.includes(el.type)) return;
        if (!el.id && !el.name && !el.placeholder) return;
        fields.push({
          id:       el.id || null,
          name:     el.name || null,
          label:    resolveLabel(el),
          type:     el.type || el.tagName.toLowerCase(),
          required: el.required || el.getAttribute('aria-required') === 'true',
          value:    null
        });
      });
      if (fields.length) found.push({ index: i, formEl: form, isCF7: form.classList.contains('wpcf7-form'), fields });
    });

    found.sort((a,b) => b.fields.length - a.fields.length);
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
    if (!label && el.nextElementSibling) {
      const next = el.nextElementSibling;
      if (next.classList && next.classList.contains('floating-label')) label = next.textContent.trim();
    }
    if (!label && el.closest('.wpcf7-form-control-wrap')) {
      const wrap = el.closest('.wpcf7-form-control-wrap');
      const parentLabel = wrap.closest('label');
      if (parentLabel) {
        const text = Array.from(parentLabel.childNodes).filter(n => n.nodeType===3).map(n=>n.textContent.trim()).filter(Boolean).join(' ');
        if (text) label = text;
      }
    }
    if (!label && el.previousElementSibling) {
      const prev = el.previousElementSibling;
      if (['LABEL','SPAN','P','DIV'].includes(prev.tagName)) label = prev.textContent.trim();
    }
    if (!label) label = el.placeholder || el.name || el.id || 'Field';
    return label.replace(/[*:\s]+$/, '').trim();
  }

  // ─── CF7 EVENT LISTENERS ──────────────────────────────────────────────────
  function registerCF7Listeners() {
    document.addEventListener('wpcf7mailsent', e => WA.bus.emit('form:submitted', { detail: e.detail }));
    document.addEventListener('wpcf7invalid', e => WA.bus.emit('form:invalid', { detail: e.detail }));
    document.addEventListener('wpcf7spam', e => WA.bus.emit('form:spam', { detail: e.detail }));
    document.addEventListener('wpcf7mailfailed', e => WA.bus.emit('form:failed', { detail: e.detail }));
  }

  // ─── INIT ────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {

    // Ensure namespace
    window.WebsiteAvatar = WA;

    if (!WA.bus) {
      const listeners = {};
      WA.bus = {
        on:   (event, fn) => { (listeners[event]=listeners[event]||[]).push(fn); },
        off:  (event, fn) => { listeners[event] = (listeners[event]||[]).filter(f=>f!==fn); },
        emit: (event, data) => { (listeners[event]||[]).forEach(fn=>fn(data)); }
      };
    }

    const pageMap = discoverPages();
    const formMap = discoverForms();

    WA.PAGE_MAP = pageMap;
    WA.FORM_MAP = formMap;
    window.PAGE_MAP = pageMap;
    window.FORM_MAP = formMap;

    registerCF7Listeners();

    if (DEBUG) {
      console.group('[WA] 🔍 Site discovery — ' + window.location.hostname);
      console.group(`[WA] 📄 Pages (${pageMap.length})`);
      pageMap.forEach(p => console.log(`  "${p.label}" → ${p.file}`));
      console.groupEnd();
      console.group(`[WA] 📋 Forms (${formMap.length})`);
      formMap.forEach(f => {
        console.group(`  Form ${f.index}${f.isCF7?' [CF7]':''}${f.formEl.id?' #' + f.formEl.id:''}`);
        f.fields.forEach(field => {
          const id = field.id ? `id=${field.id}` : `name=${field.name}`;
          console.log(`    ${id} → "${field.label}"${field.required?' *':''}`);
        });
        console.groupEnd();
      });
      console.groupEnd();
      console.groupEnd();
    }

  });

})();