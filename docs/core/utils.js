/**
 * core/utils.js — Utility Functions
 * DOM helpers, field manipulation, page/form helpers, sparkles
 * No state mutation, returns data or performs isolated DOM operations
 */

(function () {

    const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  
    // ─── LOGGING ──────────────────────────────────────────────────────────────
  
    function log(...args)  { if (WA.DEBUG) console.log('[WA]', ...args); }
    function warn(...args) { console.warn('[WA]', ...args); }
  
    // ─── HELPERS ──────────────────────────────────────────────────────────────
  
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  
    // ─── PAGE / FORM HELPERS ──────────────────────────────────────────────────
  
    function getPageMap()    { return WA.PAGE_MAP || []; }
    function getFormMap()    { return WA.FORM_MAP || []; }
  
    function getContactPage() {
      return getPageMap().find(p =>
        p.label.toLowerCase().includes('contact') ||
        p.keywords.some(k => k.includes('contact')) ||
        p.file.includes('contact')
      ) || null;
    }
  
    function freshFields() {
      const forms = getFormMap();
      if (!forms.length) return [];
      return forms[0].fields.map(f => ({ ...f, value: null }));
    }
  
    function isOnContactPage() {
      const contact = getContactPage();
      if (!contact) return false;
      const current = window.location.href.replace(/\/$/, '');
      const target  = contact.file.replace(/\/$/, '');
      return current === target || window.location.pathname === new URL(contact.file).pathname;
    }
  
    // ─── FIELD UTILITIES ──────────────────────────────────────────────────────
  
    function getFieldElement(field) {
      if (field.id) {
        const el = document.getElementById(field.id);
        if (el) return el;
      }
      if (field.name) {
        const el = document.querySelector(`[name="${field.name}"]`);
        if (el) return el;
      }
      return null;
    }
  
    function fillField(el, value) {
      if (!el) return;
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input',    { bubbles: true }));
      el.dispatchEvent(new Event('change',   { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      el.blur();
    }
  
    function fillCheckboxField(field, selectedValues) {
      if (!selectedValues?.length) return;
      const form = WA.FORM_MAP?.[0]?.formEl;
      if (!form) return;
  
      // Uncheck all first
      const allInputs = form.querySelectorAll(
        `input[type="checkbox"][name="${field.name}"], input[type="checkbox"][name="${field.name}[]"],` +
        `input[type="radio"][name="${field.name}"], input[type="radio"][name="${field.name}[]"]`
      );
      allInputs.forEach(el => { el.checked = false; });
  
      // Check selected values
      selectedValues.forEach(val => {
        const el = form.querySelector(
          `input[name="${field.name}"][value="${val}"], input[name="${field.name}[]"][value="${val}"]`
        );
        if (el) {
          el.checked = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
  
      // Highlight the group
      const firstEl = allInputs[0];
      if (firstEl) firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  
    // ─── SPARKLES ─────────────────────────────────────────────────────────────
  
    function spawnSparkles(el) {
        console.log('✨ Sparkles spawned!', el);
        console.log('Element rect:', el.getBoundingClientRect());
        console.log('Element visible?', el.offsetParent !== null);
        console.log('Existing sparkles in DOM:', document.querySelectorAll('.ai-sparkle-svg').length);
        
        if (!document.getElementById('ai-sparkle-style')) {
          const style = document.createElement('style');
          style.id = 'ai-sparkle-style';
          style.innerHTML = `
            @keyframes sparkle-pop {
              0%   { transform: scale(0) translateY(0) rotate(0deg);   opacity: 0; }
              50%  { transform: scale(1.2) translateY(-10px) rotate(90deg);  opacity: 1; }
              100% { transform: scale(0) translateY(-20px) rotate(180deg); opacity: 0; }
            }
            .ai-sparkle-svg {
              position: fixed; pointer-events: none; z-index: 999999999999;
              fill: white; mix-blend-mode: difference;
            }
          `;
          document.head.appendChild(style);
          console.log('Sparkle styles injected');
        }
      
        const rect   = el.getBoundingClientRect();
        const count  = 15;
        const stars  = [];
      
        console.log('Creating', count, 'sparkles at position:', { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
      
        for (let i = 0; i < count; i++) {
        const star = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        star.setAttribute('viewBox', '0 0 24 24');
        star.classList.add('ai-sparkle-svg');
        
        // Clamp to viewport bounds
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        let x = (rect.left - 15) + Math.random() * (rect.width + 30);
        let y = (rect.top  - 15) + Math.random() * (rect.height + 30);
        
        // If element is off-screen, use viewport center instead
        if (rect.top < 0 || rect.top > viewportHeight || rect.left < 0 || rect.left > viewportWidth) {
            console.warn('Element off-screen, using viewport center for sparkles');
            x = (viewportWidth / 2 - 50) + Math.random() * 100;
            y = (viewportHeight / 2 - 50) + Math.random() * 100;
        }
        
        const size     = 10 + Math.random() * 12;
        const delay    = 1.0 + Math.random() * 0.5;
        const duration = 1.2 + Math.random() * 0.8;
        star.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;animation:sparkle-pop ${duration}s ease-out ${delay}s both`;
        star.innerHTML = `<path d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z"/>`;
        document.body.appendChild(star);
        stars.push(star);
        }
      
        console.log('Sparkles appended to body:', stars.length);
        console.log('Sample sparkle styles:', stars[0]?.style.cssText);
      
        setTimeout(() => {
          console.log('Cleaning up sparkles');
          stars.forEach(s => s.remove());
        }, 5000);
      }
  
    // ─── EXPOSE ───────────────────────────────────────────────────────────────
  
    WA.log                = log;
    WA.warn               = warn;
    WA.sleep              = sleep;
    WA.getPageMap         = getPageMap;
    WA.getFormMap         = getFormMap;
    WA.getContactPage     = getContactPage;
    WA.freshFields        = freshFields;
    WA.isOnContactPage    = isOnContactPage;
    WA.getFieldElement    = getFieldElement;
    WA.fillField          = fillField;
    WA.fillCheckboxField  = fillCheckboxField;
    WA.spawnSparkles      = spawnSparkles;
  
  })();