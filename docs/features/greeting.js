/**
 * greeting.js — First-visit greeting widget for Website Avatar
 * Shows a welcome message on first visit, stores flag for 30 days
 */

(function() {
    'use strict';
  
    const STORAGE_KEY = 'wa_greeting_dismissed';
    const EXPIRY_DAYS = 30;
  
    window.WebsiteAvatarGreeting = {
      
      /**
       * Check if greeting should be shown
       */
      shouldShow() {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return true;
        
        try {
          const data = JSON.parse(stored);
          const now = Date.now();
          // Check if 30 days have passed
          if (now > data.expiry) {
            localStorage.removeItem(STORAGE_KEY);
            return true;
          }
          return false;
        } catch(e) {
          localStorage.removeItem(STORAGE_KEY);
          return true;
        }
      },
  
      /**
       * Mark greeting as dismissed for 30 days
       */
      dismiss() {
        const now = Date.now();
        const expiry = now + (EXPIRY_DAYS * 24 * 60 * 60 * 1000);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ expiry }));
      },
  
      /**
       * Show the greeting widget with fade-in animation
       */
      show(delay = 1000) {
        if (!this.shouldShow()) return;
        
        const greeting = document.getElementById('wa-greeting');
        if (!greeting) return;
  
        setTimeout(() => {
          greeting.classList.add('wa-greeting-visible');
        }, delay);
      },
  
      /**
       * Hide the greeting widget with fade-out
       */
      hide() {
        const greeting = document.getElementById('wa-greeting');
        if (!greeting) return;
        
        greeting.classList.remove('wa-greeting-visible');
        
        // Remove from DOM after animation completes
        setTimeout(() => {
          greeting.style.display = 'none';
        }, 400);
      },
  
      /**
       * Handle "Chat" button - open main widget
       */
      handleChat() {
        this.dismiss();
        this.hide();
        
        // Open the main chat widget
        setTimeout(() => {
          if (window.WebsiteAvatar && window.WebsiteAvatar.openChat) {
            window.WebsiteAvatar.openChat();
          }
        }, 300);
      },
  
      /**
       * Handle "Close" button - just dismiss
       */
      handleClose() {
        this.dismiss();
        this.hide();
      },
  
      /**
       * Handle speak button (if voice is enabled)
       */
      handleSpeak() {
        this.dismiss();
        this.hide();
        
        setTimeout(() => {
          if (window.WebsiteAvatar && window.WebsiteAvatar.openChat) {
            window.WebsiteAvatar.openChat();
            // Trigger voice if available
            if (window.WebsiteAvatar.startVoice) {
              setTimeout(() => window.WebsiteAvatar.startVoice(), 500);
            }
          }
        }, 300);
      },
  
      /**
       * Initialize - called from main widget
       */
      init() {
        this.attachEventListeners();
        this.show();
      },
  
      /**
       * Attach click handlers to greeting buttons
       */
      attachEventListeners() {
        const greeting = document.getElementById('wa-greeting');
        if (!greeting) return;
  
        const speakBtn = greeting.querySelector('[data-action="speak"]');
        const typeBtn = greeting.querySelector('[data-action="type"]');
        const closeBtn = greeting.querySelector('[data-action="close"]');
  
        if (speakBtn) {
          speakBtn.onclick = (e) => {
            e.preventDefault();
            this.handleSpeak();
          };
        }
  
        if (typeBtn) {
          typeBtn.onclick = (e) => {
            e.preventDefault();
            this.handleChat();
          };
        }
  
        if (closeBtn) {
          closeBtn.onclick = (e) => {
            e.preventDefault();
            this.handleClose();
          };
        }
  
        // Close on overlay click
        const overlay = greeting.querySelector('.wa-greeting-overlay');
        if (overlay) {
          overlay.onclick = (e) => {
            if (e.target === overlay) {
              this.handleClose();
            }
          };
        }
      }
    };
  
  })();