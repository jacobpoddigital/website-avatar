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
      
      // Debug: Log if subsections are found
      if (subsections && subsections.length > 0) {
        if (WA.DEBUG) console.log(`[WA:Discover] Found ${subsections.length} subsections for "${section.heading}"`);
      }
      
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

  // ─── CONTENT MAP ──────────────────────────────────────────────────────────

  // Stopwords: filtered from all keyword scoring
  const CONTENT_STOPWORDS = new Set([
    "the","a","an","and","but","or","so","to","of","in","on","at","for","with",
    "is","are","was","were","be","been","being","have","has","had","do","does",
    "did","will","would","could","should","may","might","must","can","that","this",
    "these","those","it","its","we","our","you","your","they","their","he","she",
    "his","her","us","me","my","by","from","up","out","about","into","then","than",
    "also","all","any","each","few","more","most","other","some","such","no","not",
    "only","own","same","too","very","just","what","which","who","how","when","where",
    "get","use","using","used","make","makes","made","new","need","take","give","come"
  ]);

  // Generic marketing/CTA words that add noise to keyword scoring — penalised
  const BOILERPLATE_WORDS = new Set([
    "learn","click","here","read","find","started","contact","today","call","visit",
    "see","view","discover","explore","check","download","signup","sign","login",
    "register","subscribe","follow","share","send","submit","buy","shop","order",
    "schedule","book","trial","demo","quote","estimate","consultation","appointment",
    "welcome","thanks","thank","please","available","provide","provides","providing",
    "offer","offers","offering","ensure","ensures","help","helps","helping",
    "include","includes","including","allow","allows","enable","enables"
  ]);

  // Containers to skip entirely during section discovery
  const CONTENT_SKIP = 'nav, header, footer, form, script, style, ' +
    '#wa-panel, #wa-bubble, [class*="cookie"], [class*="consent"], ' +
    '[class*="gdpr"], [class*="newsletter"], [class*="popup"], ' +
    '[class*="banner"], [class*="notice"], [class*="alert"], ' +
    '[role="banner"], [role="navigation"], [role="contentinfo"]';

  /**
   * Extract the best available title from a container element.
   * Priority: h1 → h2 → h3 → first meaningful sentence.
   */
  function extractTitle(el) {
    for (const tag of ['h1', 'h2', 'h3']) {
      const h = el.querySelector(tag);
      if (h) {
        const text = h.textContent.trim();
        if (text.length > 2) return text;
      }
    }
    const raw = el.textContent.replace(/\s+/g, ' ').trim();
    const sentence = raw.match(/[^.!?]{10,}[.!?]?/);
    return sentence ? sentence[0].trim().slice(0, 80) : raw.slice(0, 80);
  }

  /**
   * Collect all meaningful text from p, li, dt, dd inside a container.
   * Skips nav/footer/form subtrees and link-saturated nodes (nav menus
   * embedded in content areas). Falls back to raw textContent if needed.
   */
  function aggregateText(el) {
    const parts = [];
    el.querySelectorAll('p, li, dt, dd').forEach(node => {
      if (node.closest('nav, header, footer, form, #wa-panel, #wa-bubble')) return;
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (text.length < 30) return;
      // Skip nodes where the majority of text is anchor text (nav-like)
      const linkChars = Array.from(node.querySelectorAll('a'))
        .reduce((sum, a) => sum + a.textContent.length, 0);
      if (linkChars / text.length > 0.7) return;
      parts.push(text);
    });

    if (!parts.length) {
      const raw = el.textContent.replace(/\s+/g, ' ').trim();
      if (raw.length >= 30) parts.push(raw.slice(0, 600));
    }

    return [...new Set(parts)].join(' ');
  }

  /**
   * Naive suffix-stripping stemmer.
   * Collapses common forms so "design / designer / designing" count together.
   * Not linguistically perfect — intentionally lightweight.
   */
  function stemWord(word) {
    if (word.length < 5) return word;
    return word
      .replace(/ings?$/, '')    // designing → design
      .replace(/ment$/, '')     // development → develop
      .replace(/ness$/, '')     // happiness → happi
      .replace(/ation$/, 'e')   // creation → cre­ate (approx)
      .replace(/ies$/, 'y')     // companies → company
      .replace(/ers?$/, '')     // designers → design
      .replace(/ed$/, '')       // designed → design
      .replace(/ly$/, '')       // quickly → quick
      .replace(/s$/, '');       // services → service
  }

  /**
   * Deterministic keyword extraction.
   *
   * Improvements over the naive version:
   *   - Stem-based grouping: "design/designer/designing" → single bucket
   *   - Boilerplate penalty: CTA/fluff words are silently dropped
   *   - Bigram detection: adjacent content words scored as phrases (e.g. "web design")
   *     — bigrams require freq ≥ 2 to filter coincidental pairings
   *   - Heading words get 3× frequency boost (vs 2× before)
   *   - Output: top bigrams first, then single words not already covered
   */
  function extractKeywords(text, headingText) {
    headingText = headingText || '';

    const stemMap    = {};  // stem → canonical word form (most common)
    const stemFreq   = {};  // stem → accumulated score
    const bigramFreq = {};  // "w1 w2" → count

    // Collect heading words for boost
    const headingWords = new Set();
    headingText.toLowerCase()
      .split(/[\s\-_,;:.!?()[\]"'\/]+/)
      .forEach(w => {
        const c = w.replace(/[^a-z]/g, '');
        if (c.length >= 3 && !CONTENT_STOPWORDS.has(c) && !BOILERPLATE_WORDS.has(c))
          headingWords.add(c);
      });

    // Tokenise combined text (heading first so boosts flow through)
    const tokens = (headingText + ' ' + text).toLowerCase()
      .split(/[\s\-_,;:.!?()[\]"'\/]+/)
      .map(w => w.replace(/[^a-z]/g, ''))
      .filter(w => w.length >= 3 && !CONTENT_STOPWORDS.has(w));

    tokens.forEach((word, i) => {
      if (BOILERPLATE_WORDS.has(word)) return;  // silently discard fluff

      const boost = headingWords.has(word) ? 3 : 1;
      const stem  = stemWord(word);

      // Single-word: keep whichever surface form is most frequent
      if (!stemMap[stem]) stemMap[stem] = word;
      stemFreq[stem] = (stemFreq[stem] || 0) + boost;

      // Bigram: pair with the next valid (non-stopword) token
      if (i < tokens.length - 1) {
        const next = tokens[i + 1];
        if (next.length >= 3 && !CONTENT_STOPWORDS.has(next) && !BOILERPLATE_WORDS.has(next)) {
          const bigram = word + ' ' + next;
          bigramFreq[bigram] = (bigramFreq[bigram] || 0) + boost;
        }
      }
    });

    // Top unigrams (by stem score)
    const topWords = Object.entries(stemFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([stem]) => stemMap[stem]);

    // Top bigrams — require freq ≥ 2 to suppress coincidental pairs
    const topBigrams = Object.entries(bigramFreq)
      .filter(([, score]) => score >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([bigram]) => bigram);

    // Merge: bigrams first, then unigrams not already represented in a bigram
    const result = [...topBigrams];
    for (const word of topWords) {
      if (result.length >= 12) break;
      if (!result.some(b => b.includes(word))) result.push(word);
    }
    return result;
  }

  /**
   * Pick the most representative sentence from a text block (non-AI).
   * Scores each sentence by how many extracted keywords it contains —
   * the highest-scoring sentence is the summary. Falls back to first
   * sentence. Capped at 140 characters for readability.
   */
  function extractSummary(text, keywords) {
    if (!text || text.length < 40) return text || '';
    const kws = new Set(keywords.map(k => k.toLowerCase()));
    const sentences = text.match(/[^.!?]{20,}[.!?]*/g) || [text];

    let best = sentences[0];
    let bestScore = -1;

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      let score = 0;
      kws.forEach(k => { if (lower.includes(k)) score++; });
      if (score > bestScore) { bestScore = score; best = sentence; }
    }

    const trimmed = best.replace(/\s+/g, ' ').trim();
    return trimmed.length > 140 ? trimmed.slice(0, 137) + '...' : trimmed;
  }

  /**
   * Returns true when a candidate element should be rejected for low content quality:
   *   - Majority of text is link text (navigation disguised as content)
   *   - Too few words to be a meaningful section
   */
  function isLowQuality(el, text) {
    const totalChars = el.textContent.length;
    if (!totalChars) return true;

    const linkChars = Array.from(el.querySelectorAll('a'))
      .reduce((sum, a) => sum + a.textContent.length, 0);
    if (linkChars / totalChars > 0.55) return true;  // >55% link text = nav-like

    if (text.trim().split(/\s+/).length < 8) return true;  // too thin

    return false;
  }

  /**
   * Returns true when an element covers >75% of the page's text — it's a
   * mega-wrapper (e.g. <div class="site-content">) not a real section.
   */
  function isMegaWrapper(el, bodyTextLen) {
    return bodyTextLen > 0 && el.textContent.length / bodyTextLen > 0.75;
  }

  /**
   * Classify a section into a semantic type using three confidence tiers:
   *
   *   Tier 1 — class/id names     (highest confidence, checked first)
   *   Tier 2 — DOM structure      (medium confidence)
   *   Tier 3 — text body signals  (lowest confidence, fallback only)
   *
   * Splitting into tiers prevents a page whose *body text* mentions "FAQ"
   * from misclassifying an unrelated services section.
   */
  function classifySection(el, text, keywords) {
    const classSig = (el.className + ' ' + el.id).toLowerCase();
    const textSig  = text.toLowerCase();

    // ── Tier 1: class/id ──────────────────────────────────────────────────
    if (/faq|accordion/.test(classSig))                             return 'faq';
    if (/testimonial|review|rating|quote|feedback/.test(classSig)) return 'testimonials';
    if (/pric(e|ing)|plan|package|tier/.test(classSig))            return 'pricing';
    if (/team|staff|about|our.story|who.we/.test(classSig))        return 'about';
    if (/contact|touch|reach/.test(classSig))                      return 'contact';
    if (/service|solution|offering/.test(classSig))                return 'services';
    if (/feature|benefit|highlight|why.us/.test(classSig))         return 'features';
    if (/portfolio|case.stud|our.work|project/.test(classSig))     return 'portfolio';
    if (/blog|news|article|post|update/.test(classSig))            return 'blog';
    if (/gallery|photo|image.grid|lightbox/.test(classSig))        return 'gallery';
    if (/compar|versus|vs\b/.test(classSig))                       return 'comparison';

    // ── Tier 2: DOM structure ─────────────────────────────────────────────
    if (el.querySelector('h1')) return 'hero';

    // FAQ: details/summary accordion or definition list pairs
    if (el.querySelectorAll('details, summary, dt').length >= 3) return 'faq';

    // Comparison: data table present
    if (el.querySelector('table')) return 'comparison';

    // Testimonials: blockquotes
    if (el.querySelectorAll('blockquote').length >= 2) return 'testimonials';

    // Features: icon + short-text card grid
    const iconCount = el.querySelectorAll(
      'svg, img[class*="icon"], i[class*="icon"], [class*="icon"]'
    ).length;
    const cardCount = el.querySelectorAll(
      '[class*="card"], [class*="feature"], [class*="item"]'
    ).length;
    if (iconCount >= 3 && cardCount >= 3) return 'features';

    // Hero fallback: h2 + prominent CTA + short copy
    const hasCTA = el.querySelector('a.btn, a.button, a[class*="btn"], a[class*="button"]');
    const hasH2  = el.querySelector('h2');
    if (hasCTA && hasH2 && text.length < 600) return 'hero';

    // Listing: many links or card-like repeated children
    const linkCount = el.querySelectorAll('a').length;
    const listCards = el.querySelectorAll('[class*="card"], [class*="item"], li').length;
    if (linkCount > 8 || listCards > 5) return 'listing';

    // ── Tier 3: text body signals (low confidence) ────────────────────────
    if (/frequently.asked|question.*answer/.test(textSig))              return 'faq';
    if (/testimonial|said about|our client|customer.*said/.test(textSig)) return 'testimonials';
    if (/starting at|per month|per year|\$\d|£\d|€\d/.test(textSig))  return 'pricing';
    if (/our service|what we do|we offer|we provide/.test(textSig))    return 'services';
    if (/our team|meet the|about us|our story/.test(textSig))          return 'about';
    if (/get in touch|contact us|send.*message/.test(textSig))         return 'contact';

    return 'content';
  }

  /**
   * Score section importance.
   *   +3  contains h1
   *   +2  contains h2
   *   +1  contains h3
   *   +1  text > 150 words (rich content)
   *   +1  appears in earliest 30% of candidates (above-the-fold proxy)
   *   -1  text < 25 words (thin / teaser)
   */
  function weightSection(el, text, domIndex, totalCandidates) {
    let weight = 0;
    if (el.querySelector('h1'))      weight += 3;
    else if (el.querySelector('h2')) weight += 2;
    else if (el.querySelector('h3')) weight += 1;

    const wordCount = text.split(/\s+/).length;
    if (wordCount > 150) weight += 1;
    if (wordCount < 25)  weight -= 1;

    if (totalCandidates > 0 && domIndex / totalCandidates < 0.3) weight += 1;

    return weight;
  }

  /**
   * Stopword-stripped Jaccard similarity. Returns 0..1.
   * Stripping stopwords means two sections that differ only in surrounding
   * boilerplate copy (e.g. mobile vs desktop clones) are still caught.
   */
  function textSimilarity(a, b) {
    const wordsOf = str => new Set(
      str.toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 3 && !CONTENT_STOPWORDS.has(w))
    );
    const setA = wordsOf(a);
    const setB = wordsOf(b);
    if (!setA.size || !setB.size) return 0;
    let inter = 0;
    setA.forEach(w => { if (setB.has(w)) inter++; });
    return inter / (setA.size + setB.size - inter);
  }

  /**
   * Build a cheap fingerprint from the first 6 meaningful content words (sorted).
   * Used as a fast exact-match pre-check before computing full Jaccard.
   */
  function sectionFingerprint(text) {
    return text.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 4 && !CONTENT_STOPWORDS.has(w))
      .slice(0, 6)
      .sort()
      .join('|');
  }

  /**
   * Main entry point for content section discovery.
   *
   * Pipeline:
   *   1. Query structural candidates (single DOM pass)
   *   2. Filter: skip containers, mega-wrappers, nested section descendants
   *   3. Extract title, text, keywords, summary, type, weight per candidate
   *   4. Quality filter: drop low-density / nav-heavy sections
   *   5. Sort by weight (so dedup keeps the most important copy)
   *   6. Two-phase dedup: fingerprint fast-path → Jaccard similarity
   */
  function discoverSections() {
    const bodyTextLen = document.body.textContent.length;

    const structuralCandidates = Array.from(document.querySelectorAll(
      'section, main, article, ' +
      'div[class*="section"], div[class*="block"], div[class*="container"], ' +
      'div[class*="wrapper"], div[class*="content"]'
    ));

    const candidates = structuralCandidates.filter(el => {
      if (el.closest(CONTENT_SKIP)) return false;
      if (el.textContent.trim().length < 60) return false;
      if (isMegaWrapper(el, bodyTextLen)) return false;
      // Prefer outermost semantic containers — drop children of section/main/article
      return !structuralCandidates.some(
        other => other !== el &&
                 other.contains(el) &&
                 (other.tagName === 'SECTION' || other.tagName === 'MAIN' || other.tagName === 'ARTICLE')
      );
    });

    const total = candidates.length;
    const raw   = [];

    candidates.forEach((el, idx) => {
      const title = extractTitle(el);
      const text  = aggregateText(el);
      if (!text || text.length < 60) return;
      if (isLowQuality(el, text)) return;

      const keywords = extractKeywords(text, title);
      const summary  = extractSummary(text, keywords);
      const type     = classifySection(el, text, keywords);
      const weight   = weightSection(el, text, idx, total);

      raw.push({ title, text, summary, keywords, type, weight, _text: text });
    });

    // Sort by weight so dedup retains the most important version of a duplicate
    raw.sort((a, b) => b.weight - a.weight);

    // Two-phase deduplication:
    //   Phase 1 — fingerprint pre-check (O(1) per candidate, catches exact clones)
    //   Phase 2 — Jaccard similarity (catches near-clones, e.g. mobile/desktop pairs)
    const seenFp = new Set();
    const deduped = [];
    for (const section of raw) {
      const fp = sectionFingerprint(section._text);
      if (seenFp.has(fp)) continue;
      if (deduped.some(kept => textSimilarity(kept._text, section._text) > 0.78)) continue;
      seenFp.add(fp);
      deduped.push(section);
    }

    // Strip internal helper field before exposing on WA.CONTENT_MAP
    return deduped.map(({ _text, ...rest }) => rest);
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

    // ── Step 1: Build individual discovery maps ────────────────────────────
    WA.PAGE_MAP    = discoverPages();
    WA.FORM_MAP    = discoverForms();
    WA.CONTENT_MAP = discoverSections();

    // ── Step 2: Build interactive-element context (wa_el_* IDs for the agent
    //    action engine — scroll_to, click_element, filterPageContext)
    const rawCtx = buildPageContext();

    // ── Step 3: Simplified site-page references (title + url only).
    //    Used by the agent for cross-page navigation suggestions.
    //    Keeping this minimal avoids inflating every AI prompt with keyword arrays.
    const sitePages = WA.PAGE_MAP.map(p => ({ title: p.label, url: p.file }));

    // ── Step 4: Clean form view for context passing.
    //    Strips DOM refs and internal bookkeeping; keeps only what an AI needs.
    const pageForms = WA.FORM_MAP.map(f => ({
      id:     f.formEl?.id  || `form_${f.index}`,
      name:   f.formEl?.name || null,
      isCF7:  f.isCF7 || false,
      fields: f.fields.map(({ id, name, label, type, required, options }) =>
        ({ id, name, label, type, required, ...(options?.length ? { options } : {}) })
      )
    }));

    // ── Step 5: Derive a plain-text page summary.
    //    Used by the agent's arrival message: WA.PAGE_CONTEXT?.summary
    const heroSection = WA.CONTENT_MAP.find(s => s.type === 'hero') || WA.CONTENT_MAP[0];
    const summary = heroSection
      ? `${document.title} — ${heroSection.summary || heroSection.title}`
      : document.title;

    // ── Step 6: Assemble unified PAGE_CONTEXT ─────────────────────────────
    //
    //   .page      → rich context for the current page (sections + forms)
    //   .sitePages → minimal cross-page references for navigation decisions
    //   .summary   → plain-text fallback consumed by wa-agent.js arrival handler
    //   .elements  → wa_el_* interactive elements (agent scroll/click/filter)
    //   .metadata  → token/count diagnostics
    //   ._refs     → live DOM refs for scroll_to / click_element execution
    //
    //   WA.PAGE_MAP / WA.FORM_MAP remain set for utils.js helpers
    //   (getPageMap, getFormMap, freshFields, getContactPage, isOnContactPage).
    WA.PAGE_CONTEXT = {
      page: {
        title:    document.title,
        url:      window.location.href,
        sections: WA.CONTENT_MAP,
        forms:    pageForms
      },
      sitePages,
      summary,
      elements: rawCtx.elements,
      metadata: rawCtx.metadata,
      _refs:    rawCtx._refs
    };

    registerCF7Listeners();

    if (DEBUG) {
      console.group(`[WA] Site Discovery — ${window.location.hostname}`);

      // ── Page sections ──────────────────────────────────────────────────
      if (WA.PAGE_CONTEXT.page.sections.length) {
        const typeMap = WA.PAGE_CONTEXT.page.sections.reduce((acc, s) => {
          acc[s.type] = (acc[s.type] || 0) + 1;
          return acc;
        }, {});
        console.group(`[WA] Sections (${WA.PAGE_CONTEXT.page.sections.length}) — types: ${JSON.stringify(typeMap)}`);
        WA.PAGE_CONTEXT.page.sections.forEach((s, i) => {
          console.log(`  ${i + 1}. [${s.type}] w=${s.weight} "${s.title}"`);
          console.log(`     summary:  ${s.summary}`);
          console.log(`     keywords: ${s.keywords.slice(0, 6).join(', ')}`);
        });
        console.groupEnd();
      }

      // ── Site pages ─────────────────────────────────────────────────────
      console.group(`[WA] Site pages (${WA.PAGE_CONTEXT.sitePages.length})`);
      WA.PAGE_CONTEXT.sitePages.forEach(p => console.log(`  "${p.title}" → ${p.url}`));
      console.groupEnd();

      // ── Forms ──────────────────────────────────────────────────────────
      if (WA.PAGE_CONTEXT.page.forms.length) {
        console.group(`[WA] Forms (${WA.PAGE_CONTEXT.page.forms.length})`);
        WA.PAGE_CONTEXT.page.forms.forEach(f => {
          const label = f.id + (f.isCF7 ? ' [CF7]' : '');
          console.group(`  ${label}`);
          f.fields.forEach(field => {
            const key  = field.id ? `id=${field.id}` : `name=${field.name}`;
            const opts = field.options?.length ? ` [${field.options.length} opts]` : '';
            console.log(`    ${key} "${field.label}" (${field.type})${field.required ? ' *' : ''}${opts}`);
          });
          console.groupEnd();
        });
        console.groupEnd();
      }

      // ── Interactive elements ───────────────────────────────────────────
      if (WA.PAGE_CONTEXT.elements?.length) {
        const byType = WA.PAGE_CONTEXT.elements.reduce((acc, e) => {
          acc[e.type] = (acc[e.type] || 0) + 1;
          return acc;
        }, {});
        console.log(`[WA] Interactive elements (${WA.PAGE_CONTEXT.elements.length}):`, byType);
      }

      console.log(`[WA] Summary: "${WA.PAGE_CONTEXT.summary}"`);
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