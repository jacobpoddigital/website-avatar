/**
 * wa-discover.js — Website Avatar Discovery (Unified Version)
 * Generates a single compact map with sections, forms, and site pages.
 * Auto-runs on page load, stores results in WA namespace, and outputs debug logs.
 */

(function () {

  // ─── NAMESPACE ────────────────────────────────────────────────────────────
  window.WebsiteAvatar = window.WebsiteAvatar || {};
  window.WebsiteAvatar.DEBUG = window.WA_CONFIG?.debug ?? true; // Default to true for testing
  const DEBUG = window.WebsiteAvatar.DEBUG;
  const WA = window.WebsiteAvatar;

  function log(...args)  { if (DEBUG) console.log('[WA:Discover]', ...args); }
  function warn(...args) { if (DEBUG) console.warn('[WA:Discover]', ...args); }

  // ─── TOKEN ESTIMATION ─────────────────────────────────────────────────────
  
  function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  // ─── TEXT COMPRESSION ─────────────────────────────────────────────────────
  
  function compressText(text, maxTokens = 50) {
    if (!text) return '';
    const words = text.trim().split(/\s+/);
    const targetWords = Math.floor(maxTokens * 0.75);
    
    if (words.length <= targetWords) return text;
    
    const half = Math.floor(targetWords / 2);
    return words.slice(0, half).join(' ') + ' [...] ' + words.slice(-half).join(' ');
  }

  // ─── KEYWORD EXTRACTION ───────────────────────────────────────────────────
  
  function extractKeywords(text, limit = 8) {
    if (!text) return [];
    
    const stopWords = new Set([
      'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
      'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
      'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
      'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
      'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
      'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
      'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other',
      'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also',
      'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way',
      'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us'
    ]);
    
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w));
    
    const freq = {};
    words.forEach(w => freq[w] = (freq[w] || 0) + 1);
    
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([word]) => word);
  }

  // ─── SECTION TYPE DETECTION ───────────────────────────────────────────────
  
  function detectSectionType(element) {
    const classes = (element.className || '').toLowerCase();
    const id = (element.id || '').toLowerCase();
    const combined = classes + ' ' + id;
    const textContent = element.textContent.toLowerCase().slice(0, 200);
    
    if (combined.includes('hero') || (element.tagName === 'HEADER' && element.querySelector('h1'))) {
      return 'hero';
    }
    if (combined.includes('nav') || element.tagName === 'NAV') {
      return 'navigation';
    }
    if (combined.includes('footer') || element.tagName === 'FOOTER') {
      return 'footer';
    }
    if (combined.includes('faq') || textContent.includes('frequently asked')) {
      return 'faq';
    }
    if (combined.includes('testimonial') || combined.includes('review')) {
      return 'testimonials';
    }
    if (combined.includes('pricing') || combined.includes('plan')) {
      return 'pricing';
    }
    if (combined.includes('feature')) {
      return 'features';
    }
    if (combined.includes('about')) {
      return 'about';
    }
    if (combined.includes('contact')) {
      return 'contact';
    }
    if (combined.includes('cta') || combined.includes('call-to-action')) {
      return 'cta';
    }
    if (element.querySelector('article') || combined.includes('blog') || combined.includes('post')) {
      return 'article';
    }
    if (element.querySelectorAll('li').length > 5 || combined.includes('list')) {
      return 'listing';
    }
    if (element.querySelector('form')) {
      return 'form';
    }
    
    return 'content';
  }

  // ─── EXTRACT LINKS ────────────────────────────────────────────────────────
  
  function extractLinks(element) {
    const links = [];
    const anchors = element.querySelectorAll('a[href]');
    
    anchors.forEach(a => {
      const href = a.href;
      const title = (a.textContent || '').trim().slice(0, 100);
      
      if (href && title && !href.startsWith('javascript:') && !href.startsWith('#')) {
        links.push({ title, href });
      }
    });
    
    const seen = new Set();
    return links.filter(link => {
      if (seen.has(link.href)) return false;
      seen.add(link.href);
      return true;
    });
  }

  // ─── EXTRACT TEXT CONTENT ─────────────────────────────────────────────────
  
  function extractTextContent(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('script, style, nav, footer, [role="navigation"]').forEach(el => el.remove());
    
    return clone.textContent
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ─── DISCOVER SUBSECTIONS ─────────────────────────────────────────────────
  
  function discoverSubsections(element, depth = 0) {
    if (depth > 2) return [];
    
    const subsections = [];
    const candidates = element.querySelectorAll('section, article, div[class*="section"], div[class*="block"], div[class*="card"], li');
    const processed = new Set();
    
    candidates.forEach(candidate => {
      if (processed.has(candidate)) return;
      
      const textLength = candidate.textContent.trim().length;
      if (textLength < 50) return;
      if (candidate === element) return;
      
      processed.add(candidate);
      candidate.querySelectorAll('*').forEach(child => processed.add(child));
      
      const heading = candidate.querySelector('h1, h2, h3, h4, h5, h6');
      const title = heading ? heading.textContent.trim() : '';
      const text = extractTextContent(candidate);
      const type = detectSectionType(candidate);
      
      if (text.length > 50) {
        const tokenCount = estimateTokens(text);
        const compressed = compressText(text, 30);
        
        subsections.push({
          id: candidate.id || `subsection-${subsections.length}`,
          type,
          title: title.slice(0, 100),
          summary: compressed,
          keywords: extractKeywords(text, 5),
          tokenCountOriginal: tokenCount,
          tokenCountCompressed: estimateTokens(compressed),
          links: extractLinks(candidate)
        });
      }
    });
    
    return subsections;
  }

  // ─── DISCOVER SECTIONS ────────────────────────────────────────────────────
  
  function discoverSections() {
    const sections = [];
    const candidates = document.querySelectorAll('main section, main article, main > div, body > section, body > article, [role="main"] > *');
    
    candidates.forEach((element, index) => {
      const heading = element.querySelector('h1, h2, h3, h4, h5, h6');
      const title = heading ? heading.textContent.trim() : '';
      const text = extractTextContent(element);
      
      if (text.length < 100) return;
      
      const type = detectSectionType(element);
      const tokenCount = estimateTokens(text);
      const compressed = compressText(text, 100);
      const subsections = discoverSubsections(element);
      
      sections.push({
        id: element.id || `section-${index}`,
        type,
        title: title.slice(0, 150),
        summary: compressed,
        keywords: extractKeywords(text, 8),
        tokenCountOriginal: tokenCount,
        tokenCountCompressed: estimateTokens(compressed),
        links: extractLinks(element),
        subsections,
        weight: 1.0 // Placeholder for compatibility
      });
    });
    
    return sections;
  }

  // ─── DISCOVER FORMS ───────────────────────────────────────────────────────
  
  function discoverForms() {
    const forms = [];
    const formElements = document.querySelectorAll('form');
    
    formElements.forEach((form, index) => {
      const fields = [];
      const inputs = form.querySelectorAll('input, select, textarea');
      
      inputs.forEach(input => {
        const type = input.type || input.tagName.toLowerCase();
        const name = input.name || input.id || '';
        
        if (type === 'hidden' || type === 'submit' || type === 'button') return;
        
        // Find label
        let label = '';
        if (input.id) {
          const labelEl = form.querySelector(`label[for="${input.id}"]`);
          if (labelEl) label = labelEl.textContent.trim();
        }
        if (!label) {
          const parentLabel = input.closest('label');
          if (parentLabel) label = parentLabel.textContent.trim();
        }
        if (!label) {
          label = input.placeholder || input.getAttribute('aria-label') || name;
        }
        
        const required = input.required || input.getAttribute('aria-required') === 'true';
        
        // Collect options for checkbox/radio/select
        let options = [];
        if (type === 'checkbox' || type === 'radio') {
          const siblings = form.querySelectorAll(`input[name="${name}"]`);
          siblings.forEach(sib => {
            const sibLabel = sib.nextSibling?.textContent?.trim() || 
                            sib.closest('label')?.textContent?.trim() || 
                            sib.value;
            if (sibLabel && !options.includes(sibLabel)) {
              options.push(sibLabel);
            }
          });
        }
        
        if (input.tagName === 'SELECT') {
          options = Array.from(input.options)
            .map(opt => opt.textContent.trim())
            .filter(Boolean);
        }
        
        fields.push({
          id: input.id || null,
          name,
          label: label.slice(0, 100),
          type,
          required,
          value: null, // Placeholder for compatibility
          ...(options.length > 0 && { options })
        });
      });
      
      forms.push({
        index,
        formEl: form,
        isCF7: form.classList.contains('wpcf7-form'),
        fields
      });
    });
    
    return forms;
  }

  // ─── DISCOVER SITE PAGES ──────────────────────────────────────────────────
  
  function discoverSitePages() {
    const pages = [];
    const links = document.querySelectorAll('nav a[href], header a[href], footer a[href], [role="navigation"] a[href]');
    const currentOrigin = window.location.origin;
    const seen = new Set();
    
    const SKIP_HREF = [
      /^tel:/, /^mailto:/, /^javascript:/,
      /whatsapp\.com/, /facebook\.com/, /twitter\.com/, /linkedin\.com/,
      /instagram\.com/, /youtube\.com/, /tiktok\.com/,
      /terms/, /privacy/, /cookies/, /sitemap/, /wp-login/, /wp-admin/
    ];
    
    links.forEach(a => {
      const href = a.href;
      const raw = a.getAttribute('href') || '';
      const title = a.textContent.trim();
      
      if (!href.startsWith(currentOrigin)) return;
      if (SKIP_HREF.some(p => p.test(raw) || p.test(href))) return;
      if (raw === '#' || raw.endsWith('/#')) return;
      if (seen.has(href)) return;
      
      seen.add(href);
      
      // Build keywords for compatibility with utils.js
      const words = title.toLowerCase().split(/[\s/\-&]+/).filter(w => w.length > 1);
      const keywords = [...new Set([title.toLowerCase(), ...words])];
      
      pages.push({
        label: title.slice(0, 100),
        file: href,
        keywords
      });
    });
    
    // Ensure homepage first
    const homeIdx = pages.findIndex(p =>
      p.file === currentOrigin + '/' ||
      p.file === currentOrigin ||
      p.file.endsWith('/index.html') ||
      p.label.toLowerCase() === 'home'
    );
    
    if (homeIdx > 0) {
      const [home] = pages.splice(homeIdx, 1);
      pages.unshift(home);
    }
    
    if (!pages.length || !pages[0].keywords.some(k => ['home','homepage'].includes(k))) {
      pages.unshift({
        label: 'Homepage',
        file: currentOrigin + '/',
        keywords: ['home', 'homepage', 'home page', 'main page', 'start']
      });
    }
    
    return pages;
  }

  // ─── CF7 EVENT LISTENERS ──────────────────────────────────────────────────
  
  function registerCF7Listeners() {
    if (!WA.bus) {
      const listeners = {};
      WA.bus = {
        on: (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); },
        off: (evt, fn) => { listeners[evt] = (listeners[evt] || []).filter(f => f !== fn); },
        emit: (evt, data) => { (listeners[evt] || []).forEach(f => f(data)); }
      };
    }
    
    document.addEventListener('wpcf7mailsent', e => WA.bus.emit('form:submitted', { detail: e.detail }));
    document.addEventListener('wpcf7invalid', e => WA.bus.emit('form:invalid', { detail: e.detail }));
    document.addEventListener('wpcf7spam', e => WA.bus.emit('form:spam', { detail: e.detail }));
    document.addEventListener('wpcf7mailfailed', e => WA.bus.emit('form:failed', { detail: e.detail }));
  }

  // ─── MAIN DISCOVERY ───────────────────────────────────────────────────────
  
  function initDiscovery() {
    log('🔍 Starting unified page discovery...');
    
    const pageTitle = document.title || 'Untitled Page';
    const pageUrl = window.location.href;
    
    // Step 1: Build individual maps (for backward compatibility)
    WA.PAGE_MAP = discoverSitePages();
    WA.FORM_MAP = discoverForms();
    WA.CONTENT_MAP = discoverSections();
    
    // Step 2: Calculate stats
    const totalOriginalTokens = WA.CONTENT_MAP.reduce((sum, s) => sum + s.tokenCountOriginal, 0);
    const totalCompressedTokens = WA.CONTENT_MAP.reduce((sum, s) => sum + s.tokenCountCompressed, 0);
    
    // Step 3: Build simplified views for PAGE_CONTEXT
    const sitePages = WA.PAGE_MAP.map(p => ({ title: p.label, url: p.file }));
    
    const pageForms = WA.FORM_MAP.map(f => ({
      id: f.formEl?.id || `form-${f.index}`,
      name: f.formEl?.name || null,
      isCF7: f.isCF7 || false,
      fields: f.fields.map(({ id, name, label, type, required, options }) =>
        ({ id, name, label, type, required, ...(options?.length ? { options } : {}) })
      )
    }));
    
    // Step 4: Build summary
    const heroSection = WA.CONTENT_MAP.find(s => s.type === 'hero') || WA.CONTENT_MAP[0];
    const summary = heroSection
      ? `${pageTitle} — ${heroSection.summary || heroSection.title}`
      : pageTitle;
    
    // Step 5: Build unified PAGE_CONTEXT
    WA.PAGE_CONTEXT = {
      page: {
        title: pageTitle,
        url: pageUrl,
        sections: WA.CONTENT_MAP,
        forms: pageForms,
        stats: {
          sectionCount: WA.CONTENT_MAP.length,
          formCount: WA.FORM_MAP.length,
          totalOriginalTokens,
          totalCompressedTokens,
          compressionRatio: totalOriginalTokens > 0 
            ? (totalCompressedTokens / totalOriginalTokens * 100).toFixed(1) + '%'
            : '0%'
        }
      },
      sitePages,
      summary
    };
    
    registerCF7Listeners();
    
    // Step 6: Debug output
    if (DEBUG) {
      console.group(`🌐 [WA] Site Discovery — ${window.location.hostname}`);
      
      // Stats summary
      console.log('📊 Stats:', WA.PAGE_CONTEXT.page.stats);
      
      // Sections
      if (WA.CONTENT_MAP.length) {
        const typeMap = WA.CONTENT_MAP.reduce((acc, s) => {
          acc[s.type] = (acc[s.type] || 0) + 1;
          return acc;
        }, {});
        console.group(`📄 Sections (${WA.CONTENT_MAP.length}) — types: ${JSON.stringify(typeMap)}`);
        WA.CONTENT_MAP.forEach((s, i) => {
          console.log(`  ${i + 1}. [${s.type}] "${s.title}"`);
          console.log(`     summary: ${s.summary}`);
          console.log(`     keywords: ${s.keywords.slice(0, 6).join(', ')}`);
          if (s.subsections?.length) {
            console.log(`     subsections: ${s.subsections.length}`);
          }
        });
        console.groupEnd();
      }
      
      // Site pages
      console.group(`🔗 Site Pages (${sitePages.length})`);
      sitePages.forEach(p => console.log(`  "${p.title}" → ${p.url}`));
      console.groupEnd();
      
      // Forms
      if (pageForms.length) {
        console.group(`📝 Forms (${pageForms.length})`);
        pageForms.forEach(f => {
          const label = f.id + (f.isCF7 ? ' [CF7]' : '');
          console.group(`  ${label}`);
          f.fields.forEach(field => {
            const key = field.id ? `id=${field.id}` : `name=${field.name}`;
            const opts = field.options?.length ? ` [${field.options.length} opts]` : '';
            console.log(`    ${key} "${field.label}" (${field.type})${field.required ? ' *' : ''}${opts}`);
          });
          console.groupEnd();
        });
        console.groupEnd();
      }
      
      console.log('📋 Summary:', summary);
      console.log('📦 Full Context:', WA.PAGE_CONTEXT);
      console.groupEnd();
    }
    
    log('✅ Discovery complete!');
  }

  // ─── RUN ──────────────────────────────────────────────────────────────────
  
  function runDiscovery() {
    if (WA._discoveryDone) return;
    WA._discoveryDone = true;
    initDiscovery();
  }

  // Expose manual trigger
  window.WA_DISCOVER = runDiscovery;

  // Auto-run on DOM ready with delay for dynamic content
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(runDiscovery, 1000);
    });
  } else {
    setTimeout(runDiscovery, 1000);
  }

})();