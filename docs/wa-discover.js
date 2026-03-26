/**
 * wa-discover-enhanced.js — Website Avatar by AdVelocity
 * Enhanced site discovery with semantic compression and improved page context.
 * Builds PAGE_MAP, FORM_MAP, and enriched PAGE_CONTEXT from the live DOM.
 * Runs before wa-agent.js. Exposes results on window.WebsiteAvatar.
 */

(function () {

  // ─── NAMESPACE ────────────────────────────────────────────────────────────
  window.WebsiteAvatar = window.WebsiteAvatar || {};
  window.WebsiteAvatar.DEBUG = window.WA_CONFIG?.debug || false;
  const DEBUG = window.WebsiteAvatar.DEBUG;
  const WA = window.WebsiteAvatar;

  function log(...args)  { if (DEBUG) console.log('[WA:Discover]', ...args); }
  function warn(...args) { if (DEBUG) console.warn('[WA:Discover]', ...args); }

  // ─── SEMANTIC COMPRESSION ─────────────────────────────────────────────────
  const LIGHT_STOPWORDS = new Set([
    "the", "a", "an", "and", "but", "or", "so", "to", "of", "in", "on", "at",
    "for", "with", "is", "are", "was", "were", "be", "been", "being", "have",
    "has", "had", "do", "does", "did", "will", "would", "could", "should",
    "may", "might", "must", "can", "that", "this", "these", "those"
  ]);

  function estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  function getFirstSentences(text, count = 1) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    return sentences.slice(0, count).join(" ").trim();
  }

  function smartCompress(sentence) {
    return sentence
      .split(/\s+/)
      .filter(word => {
        const clean = word.toLowerCase().replace(/[^\w]/g, "");
        if (["by", "for", "with", "to"].includes(clean)) return true;
        return !LIGHT_STOPWORDS.has(clean);
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function refine(text) {
    return text
      .replace(/\b(designed|provides|includes|that|which)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function summarise(text) {
    if (!text || text.length < 50) return text;
    const first = getFirstSentences(text, 1);
    const compressed = smartCompress(first);
    return refine(compressed);
  }

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
      const seenGroups = new Set();

      form.querySelectorAll(VALID_TAGS.join(',')).forEach(el => {
        const type = el.type || el.tagName.toLowerCase();

        // ── Checkbox / Radio groups ──────────────────────────────────────────
        if (type === 'checkbox' || type === 'radio') {
          const groupName = el.name ? el.name.replace(/\[\]$/, '') : null;
          if (!groupName) return;
          if (seenGroups.has(groupName)) return;
          seenGroups.add(groupName);

          const groupEls = Array.from(
            form.querySelectorAll(`input[type="${type}"][name="${el.name}"], input[type="${type}"][name="${groupName}[]"]`)
          );
          if (!groupEls.length) return;

          const options = groupEls.map(opt => {
            const parentLabel = opt.closest('label');
            const optLabel = parentLabel
              ? parentLabel.textContent.trim()
              : (opt.nextElementSibling?.textContent?.trim() || opt.value);
            return { value: opt.value, label: optLabel };
          });

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
            options,
            value:    null
          });
          return;
        }

        // ── Standard fields ──────────────────────────────────────────────────
        if (SKIP_TYPES.includes(type)) return;
        if (!el.id && !el.name && !el.placeholder) return;

        const label = resolveLabel(el);

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

  // ─── SEMANTIC SECTION BUILDER ─────────────────────────────────────────────
  function buildSemanticSections() {
    const elements = Array.from(document.body.querySelectorAll("h1, h2, h3, h4, h5, h6, p"));
    const sections = [];
    let currentSection = null;

    elements.forEach(el => {
      // Skip elements inside widget or skip containers
      if (el.closest('#wa-panel, #wa-bubble')) return;
      if (el.closest('[class*="cookie"], [class*="consent"], [class*="gdpr"], [class*="newsletter"]')) return;

      if (el.tagName.match(/^H[1-6]$/)) {
        if (currentSection) {
          sections.push(currentSection);
        }
        currentSection = {
          heading: el.innerText.trim(),
          headingEl: el,
          content: [],
          level: parseInt(el.tagName[1])
        };
      } else if (el.tagName === "P" && currentSection) {
        const text = el.innerText.trim();
        if (text.length > 40) {
          currentSection.content.push(text);
        }
      }
    });

    if (currentSection) {
      sections.push(currentSection);
    }

    // Calculate token estimates and create summaries
    return sections.map(section => {
      const combinedText = section.content.join(" ");
      const summary = summarise(combinedText);
      
      // Extract nested subsections from ul > li structures
      const subsections = extractSubsections(section.headingEl);
      
      return {
        heading: section.heading,
        level: section.level,
        summary,
        subsections,
        originalLength: combinedText.length,
        originalTokens: estimateTokens(combinedText),
        compressedTokens: estimateTokens(summary),
        element: section.headingEl
      };
    });
  }
  
  // ─── SUBSECTION EXTRACTOR ─────────────────────────────────────────────────
  function extractSubsections(parentHeadingEl) {
    const subsections = [];
    
    // Find the content container after this heading
    const container = parentHeadingEl.parentElement;
    if (!container) return subsections;
    
    // Look for child headings that are nested under this section
    const childHeadings = [];
    let currentEl = parentHeadingEl.nextElementSibling;
    
    // Traverse siblings until we hit another heading of same/higher level or run out
    const parentLevel = parseInt(parentHeadingEl.tagName[1]);
    
    while (currentEl) {
      // Stop if we hit a heading of same or higher level
      if (currentEl.tagName && currentEl.tagName.match(/^H[1-6]$/)) {
        const level = parseInt(currentEl.tagName[1]);
        if (level <= parentLevel) break;
      }
      
      // Find h3, h4, h5, h6 AND .heading elements within this sibling
      if (currentEl.querySelectorAll) {
        const tagHeadings = currentEl.querySelectorAll('h3, h4, h5, h6');
        const classHeadings = currentEl.querySelectorAll('.heading, [class*="title"]:not(.post-meta)');
        
        tagHeadings.forEach(h => childHeadings.push(h));
        classHeadings.forEach(h => {
          // Only add if it's not already captured as a tag heading
          if (!h.tagName.match(/^H[1-6]$/)) {
            childHeadings.push(h);
          }
        });
      }
      
      currentEl = currentEl.nextElementSibling;
    }
    
    // Process each child heading + its content
    childHeadings.forEach(heading => {
      const title = heading.textContent.trim();
      if (!title || title.length < 3) return;
      
      // Get link if heading contains or is wrapped by one
      const link = heading.querySelector('a') || heading.closest('a');
      const url = link ? link.href : null;
      
      // Gather content: look at siblings and children of the heading's parent container
      let description = '';
      const headingContainer = heading.closest('li, .box-list-item, [class*="item"], [class*="card"], div');
      
      if (headingContainer) {
        // Get all paragraphs within this container, skip metadata
        const paragraphs = headingContainer.querySelectorAll('p:not(.post-meta p)');
        description = Array.from(paragraphs)
          .map(p => p.textContent.trim())
          .filter(p => p.length > 20 && !p.startsWith('By ')) // Skip author/date lines
          .join(' ');
      }
      
      if (!description || description.length < 20) return;
      
      const compressedDesc = summarise(description);
      subsections.push({
        title,
        url,
        description: compressedDesc,
        tokens: estimateTokens(compressedDesc)
      });
    });
    
    // Deduplicate by title
    const seen = new Set();
    return subsections.filter(sub => {
      if (seen.has(sub.title)) return false;
      seen.add(sub.title);
      return true;
    });
  }

  // ─── PAGE CONTEXT WITH SEMANTIC SECTIONS ──────────────────────────────────
  function buildPageContext() {
    const elements = [];
    let idx = 0;
    const seen = new Set();

    function addEl(el) {
      const key = el.type + ':' + (el.text || el.title || '');
      if (seen.has(key)) return;
      seen.add(key);
      elements.push({ id: `wa_el_${idx++}`, ...el });
    }

    // ── Skip containers ──────────────────────────────────────────────────────
    const SKIP_CONTAINERS = [
      '[class*="cookie"]', '[class*="consent"]', '[class*="gdpr"]',
      '[class*="privacy"]', '[id*="cookie"]', '[id*="consent"]',
      '[id*="gdpr"]', '[class*="newsletter"]', '[class*="popup"]',
      '[class*="modal"]:not(.wa-)', '[role="dialog"]', '[aria-modal]'
    ].join(', ');

    const CTA_SKIP_WORDS = /^(menu|nav|close|open|toggle|search|submit|send|next|prev|back|more|less|show|hide|expand|collapse|\d+|customise|customize|accept|accept all|reject|reject all|save my preferences|necessary|functional|analytics|performance|advertisement|uncategorised|uncategorized|subscribe|sign up|newsletter|manage|manage cookies|manage preferences|cookie|privacy|i agree|agree|decline|got it|ok|okay)$/i;

    // ── CTAs — buttons and prominent links ───────────────────────────────────
    const CTA_SELECTORS = 'a.btn, a.button, a[class*="btn"], a[class*="button"], button:not([type="submit"]):not([type="reset"]):not(.wa-), input[type="button"]';

    document.querySelectorAll(CTA_SELECTORS).forEach(el => {
      const text = el.textContent.trim().replace(/\s+/g, ' ');
      if (!text || text.length < 3 || text.length > 60) return;
      if (CTA_SKIP_WORDS.test(text)) return;
      if (el.closest('#wa-panel, #wa-bubble')) return;
      if (el.closest(SKIP_CONTAINERS)) return;

      // Extract surrounding context for better understanding
      const parentSection = el.closest('section, article, div[class*="section"], div[class*="content"]');
      let context = null;
      if (parentSection) {
        const heading = parentSection.querySelector('h1, h2, h3, h4, h5, h6');
        if (heading) context = heading.textContent.trim();
      }

      addEl({
        type:    'button',
        text,
        context,
        role:    'cta',
        actions: ['click'],
        _el:     el
      });
    });

    // ── Semantic sections with compressed content ────────────────────────────
    const semanticSections = buildSemanticSections();
    semanticSections.forEach(section => {
      // Keep sections that have either a summary OR subsections
      if ((!section.summary || section.summary.length < 10) && (!section.subsections || section.subsections.length === 0)) {
        return; // Skip sections with no content
      }

      const sectionEl = {
        type:    'section',
        title:   section.heading,
        summary: section.summary || '',
        level:   section.level,
        tokens:  section.compressedTokens,
        originalTokens: section.originalTokens,
        role:    'content_section',
        actions: ['scroll', 'read'],
        _el:     section.element.closest('section, article, div[id], div[class]') || section.element.parentElement
      };
      
      // Add subsections if any exist
      if (section.subsections && section.subsections.length > 0) {
        sectionEl.subsections = section.subsections;
      }
      
      addEl(sectionEl);
    });

    // ── Phone numbers ─────────────────────────────────────────────────────────
    document.querySelectorAll('a[href^="tel:"]').forEach(el => {
      const number = el.href.replace('tel:', '').trim();
      const label  = el.textContent.trim() || number;
      addEl({
        type:    'phone',
        text:    label,
        number,
        role:    'contact',
        actions: ['click'],
        _el:     el
      });
    });

    // ── Email addresses ───────────────────────────────────────────────────────
    document.querySelectorAll('a[href^="mailto:"]').forEach(el => {
      const email = el.href.replace('mailto:', '').trim();
      const label = el.textContent.trim() || email;
      addEl({
        type:    'email',
        text:    label,
        email,
        role:    'contact',
        actions: ['click'],
        _el:     el
      });
    });

    // ── Videos ────────────────────────────────────────────────────────────────
    document.querySelectorAll('video, iframe[src*="youtube"], iframe[src*="vimeo"], [class*="video-wrapper"], [class*="video-container"]').forEach(el => {
      const title = el.getAttribute('title') || el.getAttribute('aria-label') || 'Video';
      
      // Try to find nearby heading for context
      const parent = el.closest('section, article, div[class*="video"]');
      let context = null;
      if (parent) {
        const heading = parent.querySelector('h1, h2, h3, h4, h5, h6');
        if (heading) context = heading.textContent.trim();
      }

      addEl({
        type:    'video',
        title,
        context,
        role:    'media',
        actions: ['scroll', 'play'],
        _el:     el
      });
    });

    // ── Images with meaningful alt text ───────────────────────────────────────
    document.querySelectorAll('img[alt]').forEach(el => {
      const alt = el.alt.trim();
      if (!alt || alt.length < 5) return;
      if (el.closest('#wa-panel, #wa-bubble')) return;
      if (el.closest(SKIP_CONTAINERS)) return;
      // Skip icons and decorative images
      if (el.width < 100 && el.height < 100) return;

      addEl({
        type:    'image',
        alt,
        role:    'media',
        actions: ['scroll'],
        _el:     el
      });
    });

    // Remove _el before serialising
    const serialisable = elements.map(({ _el, ...rest }) => rest);

    // Calculate total token efficiency
    const sectionElements = elements.filter(e => e.type === 'section');
    const totalTokens = sectionElements.reduce((sum, e) => sum + (e.tokens || 0), 0);

    return {
      page:     document.title,
      url:      window.location.href,
      elements: serialisable,
      metadata: {
        totalElements: serialisable.length,
        contentSections: sectionElements.length,
        estimatedTokens: totalTokens,
        discoveredAt: new Date().toISOString()
      },
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
      console.group(`[WA] 🔍 Enhanced Site Discovery — ${window.location.hostname}`);
      
      console.group(`[WA] 📄 Pages (${WA.PAGE_MAP.length})`);
      WA.PAGE_MAP.forEach(p => console.log(`  "${p.label}" → ${p.file}`));
      console.groupEnd();
      
      if (WA.PAGE_CONTEXT?.elements?.length) {
        console.group(`[WA] 🎯 Page Elements (${WA.PAGE_CONTEXT.elements.length})`);
        
        const byType = WA.PAGE_CONTEXT.elements.reduce((acc, e) => {
          acc[e.type] = (acc[e.type] || 0) + 1;
          return acc;
        }, {});
        console.log('Element types:', byType);
        
        // Show compression stats for sections
        const sections = WA.PAGE_CONTEXT.elements.filter(e => e.type === 'section');
        if (sections.length > 0) {
          let totalOriginal = 0;
          let totalCompressed = 0;
          
          console.group(`📦 Content Compression (${sections.length} sections)`);
          sections.forEach((e, i) => {
            const original = e.originalTokens || 0;
            const compressed = e.tokens || 0;
            const reduction = original > 0 ? Math.round((1 - compressed / original) * 100) : 0;
            
            totalOriginal += original;
            totalCompressed += compressed;
            
            console.log(`  Section ${i + 1}: ${e.title}`);
            console.log(`    Summary: ${e.summary}`);
            console.log(`    Tokens (Original): ${original}`);
            console.log(`    Tokens (Compressed): ${compressed}`);
            console.log(`    Reduction: ${reduction}%`);
          });
          
          const overallReduction = totalOriginal > 0 
            ? Math.round((1 - totalCompressed / totalOriginal) * 100) 
            : 0;
          
          console.log(`\n📊 TOTALS:`);
          console.log(`  Original Tokens: ${totalOriginal}`);
          console.log(`  Compressed Tokens: ${totalCompressed}`);
          console.log(`  Overall Reduction: ${overallReduction}%`);
          console.groupEnd();
        }
        
        console.groupEnd();

        if (WA.PAGE_CONTEXT.metadata) {
          console.group(`[WA] 📊 Metadata`);
          console.log('Total elements:', WA.PAGE_CONTEXT.metadata.totalElements);
          console.log('Content sections:', WA.PAGE_CONTEXT.metadata.contentSections);
          console.log('Estimated tokens:', WA.PAGE_CONTEXT.metadata.estimatedTokens);
          console.groupEnd();
        }
      }
      
      console.group(`[WA] 📋 Forms (${WA.FORM_MAP.length})`);
      WA.FORM_MAP.forEach(f => {
        console.group(`  Form ${f.index}${f.isCF7 ? ' [CF7]' : ''}${f.formEl.id ? ' #' + f.formEl.id : ''}`);
        f.fields.forEach(field => {
          const id = field.id ? `id=${field.id}` : `name=${field.name}`;
          const opts = field.options?.length ? ` [${field.options.length} options]` : '';
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

  // Run once on DOM ready with delay for dynamic content (Swiper, etc)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(runDiscovery, 1000);
    });
  } else {
    setTimeout(runDiscovery, 1000);
  }

})();