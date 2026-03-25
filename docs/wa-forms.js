/**
 * wa-forms.js — Form fill orchestration
 * AI-driven conversation to collect user details and fill Contact Form 7.
 */

(function () {

    const WA = window.WebsiteAvatar;
    if (!WA) { console.error('[WA:Forms] Core not loaded'); return; }
  
    WA.formState = {
      active: false,
      action: null
    };
  
    let formAIController = null;
    let _completeFormFillAttempts = 0;
  
    // ─── FRESH FIELDS ─────────────────────────────────────────────────────────
    WA.freshFields = function() {
      const forms = WA.FORM_MAP || [];
      if (!forms.length) return [];
      return forms[0].fields.map(f => ({ ...f, value: null }));
    };
  
    // ─── START FORM FILL ──────────────────────────────────────────────────────
    WA.startFormFill = async function(action) {
      if (WA.formState.active) return;
  
      WA.formState.active = true;
      WA.formState.action = action;
  
      WA.session.activeFormActionId = action.id;
      WA.saveSession();
  
      WA.openPanel();
      WA.updateAbortButton();
      repopulateFields(action);
  
      // Re-enable send button — form fill requires it
      const sendBtn = document.getElementById('wa-send');
      if (sendBtn) { sendBtn.disabled = false; sendBtn.title = ''; }
  
      // Kick off AI — do NOT await, the fill_form Promise stays open until finishFormFill
      handleFormInputAI('__RESUME__');
    };
  
    // ─── AI FORM FILL CONVERSATION ───────────────────────────────────────────
    async function handleFormInputAI(userText) {
      if (!WA.formState.action) return;
  
      if (formAIController) formAIController.abort();
      formAIController = new AbortController();
  
      const fields   = WA.formState.action.payload.fields;
      const isResume = userText === '__RESUME__';
  
      const fieldSummary = fields.map((f, idx) => {
        const val  = f.value
          ? (Array.isArray(f.value) ? f.value.join(', ') : '"' + f.value + '"')
          : 'empty';
        const opts = f.options?.length
          ? ` | options: [${f.options.map(o => o.value).join(', ')}]`
          : '';
        const multi = f.type === 'checkbox' ? ' | multi-select' : (f.type === 'radio' ? ' | single-select' : '');
        const typeHint = ['checkbox','radio','select'].includes(f.type)
          ? ` ⚠️ USE show_options action for this field`
          : '';
        return `${idx + 1}. ${f.label} (name: ${f.name}, type: ${f.type}${f.required ? ', required' : ', optional'}${multi}${opts}): ${val}${typeHint}`;
      }).join('\n');
  
      const recentMsgs = WA.session.messages.slice(-6).map(m =>
        `${m.role === 'user' ? 'User' : 'Agent'}: ${m.text}`
      ).join('\n');
  
      const prompt = `You are managing a form fill conversation for a website contact form.
  
  FORM FIELDS (name | type | required | current value):
  ${fieldSummary}
  
  RECENT CONVERSATION:
  ${recentMsgs}
  
  USER JUST SAID: "${isResume ? '(continuing form fill — do NOT greet again, just ask for the next empty required field in sequence)' : userText}"
  
  Reply with JSON only, no explanation:
  {
    "action": "fill_field" | "correct_field" | "show_options" | "submit_ready" | "abort" | "ask_again",
    "field_name": "name attribute of field to update, or null",
    "value": "value to set for fill_field/correct_field, or null",
    "options": ["option1", "option2"] | null,
    "multi": true | false,
    "message": "what to say to the user",
    "all_required_filled": true | false
  }
  
  Rules:
  - abort: user wants to stop, cancel, or leave (any phrasing)
  - fill_field: user provided a value for a plain text/email/tel/textarea field
  - correct_field: user is correcting a previously filled field
  - show_options: field is type checkbox, radio, or select — render options as buttons for user to pick
  - submit_ready: all required fields are filled
  - ask_again: input was unclear or ambiguous
  - IMPORTANT: Ask for fields strictly in the numbered order listed above — never skip or reorder
  - After filling a field, confirm and ask for the NEXT field in sequence by number
  - For checkbox/radio/select fields: always return show_options — never ask user to type their choice
  - For show_options include field_name and all options from the field definition
  - If all required fields are now filled, set action to submit_ready and all_required_filled to true
  - Never ask for a field that already has a value unless user is correcting it
  - Validate email format, phone must have at least 7 digits — if invalid ask user to correct it`;
  
      WA.showTyping();
      WA.log('→ Form AI request sent');
      const t0 = Date.now();
  
      try {
        const res = await fetch(WA.OPENAI_PROXY, {
          method:  'POST',
          signal:  formAIController.signal,
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ prompt, maxTokens: 350 })
        });
  
        if (!res.ok) throw new Error(`Proxy error: ${res.status}`);
  
        const data = await res.json();
        const raw  = data.content || '';
        WA.log(`← Form AI ${Date.now() - t0}ms:`, raw.trim());
  
        let parsed;
        try {
          parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
        } catch(e) {
          WA.warn('Form AI bad JSON:', raw);
          WA.hideTyping();
          WA.agentSay("Sorry, I didn't catch that — could you say it again?");
          return;
        }
  
        WA.hideTyping();
  
        if (parsed.action === 'abort') {
          abandonFormFill();
          return;
        }
  
        // show_options — render multi/single select card
        if (parsed.action === 'show_options' && parsed.field_name) {
          const field = fields.find(f => f.name === parsed.field_name);
          if (field) {
            if (parsed.message) WA.agentSay(parsed.message);
            WA.renderOptionsCard(field, parsed.multi !== false, (selected) => {
              field.value = selected;
              fillCheckboxField(field, selected);
              WA.saveSession();
              const summary = selected.length ? `Selected: ${selected.join(', ')}` : '(skipped)';
              handleFormInputAI(summary);
            });
            return;
          }
        }
  
        if (parsed.action === 'fill_field' || parsed.action === 'correct_field') {
          const field = fields.find(f => f.name === parsed.field_name);
          if (field) {
            // Intercept choice fields
            if (['checkbox', 'radio', 'select'].includes(field.type) && field.options?.length) {
              if (parsed.message) WA.agentSay(parsed.message);
              WA.renderOptionsCard(field, field.type !== 'radio', (selected) => {
                field.value = selected;
                if (field.type === 'select') {
                  const el = getFieldElement(field);
                  if (el) { el.value = selected[0] || ''; fillField(el, selected[0] || ''); }
                } else {
                  fillCheckboxField(field, selected);
                }
                WA.saveSession();
                const summary = selected.length ? `Selected: ${selected.join(', ')}` : '(skipped)';
                handleFormInputAI(summary);
              });
              return;
            }
  
            if (parsed.value) {
              field.value = parsed.value;
              const el = getFieldElement(field);
              if (el) {
                el.classList.add('wa-filling');
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                fillField(el, parsed.value);
              }
              WA.saveSession();
            } else {
              if (parsed.message) WA.agentSay(parsed.message);
              return;
            }
          }
        }
  
        if (parsed.action === 'submit_ready' || parsed.all_required_filled) {
          setTimeout(completeFormFill, 400);
          return;
        }
  
        if (parsed.message) WA.agentSay(parsed.message);
  
      } catch(e) {
        if (e.name === 'AbortError') { WA.log('Form AI cancelled'); return; }
        WA.warn('Form AI error:', e.message);
        WA.hideTyping();
        WA.agentSay("Something went wrong. Let's try that again.");
        setTimeout(() => handleFormInputAI('__RESUME__'), 1000);
      }
    }
  
    // ─── COMPLETE FORM FILL ───────────────────────────────────────────────────
    function completeFormFill() {
      if (!WA.formState.action) return;
      const fields  = WA.formState.action.payload.fields;
      const missing = fields.filter(f => f.required && !f.value);
  
      if (missing.length) {
        _completeFormFillAttempts++;
        if (_completeFormFillAttempts <= 2) {
          handleFormInputAI('__RESUME__');
        } else {
          _completeFormFillAttempts = 0;
          WA.agentSay("Let's make sure we have everything. Please check the form and fill in any missing fields.");
        }
        return;
      }
  
      _completeFormFillAttempts = 0;
      
      const summary = fields
        .filter(f => f.value)
        .map(f => {
          const val = Array.isArray(f.value) ? f.value.join(', ') : f.value;
          return `${f.label}: ${val}`;
        })
        .join('\n');
  
      WA.renderCard({
        label: 'Ready to submit',
        message: `I've filled in:\n\n${summary}\n\nShall I submit this for you?`,
        buttons: [
          { text: 'Submit', style: 'confirm', action: () => WA.submitForm() },
          { text: 'Edit', style: 'deny', action: () => {
            WA.agentSay("No problem — what would you like to change?");
            setTimeout(() => handleFormInputAI('__RESUME__'), 400);
          }}
        ]
      });
    }
  
    // ─── SUBMIT FORM ──────────────────────────────────────────────────────────
    WA.submitForm = async function() {
      if (!WA.formState.action) return;
  
      const forms = WA.FORM_MAP || [];
      if (!forms.length) return;
  
      const formEl = forms[0].formEl;
      if (!formEl) return;
  
      WA.agentSay("Submitting your enquiry…");
  
      // Listen for CF7 events
      const onSuccess = () => {
        document.removeEventListener('wpcf7mailsent', onSuccess);
        document.removeEventListener('wpcf7invalid', onError);
        finishFormFill();
      };
  
      const onError = (e) => {
        document.removeEventListener('wpcf7mailsent', onSuccess);
        document.removeEventListener('wpcf7invalid', onError);
        handleCF7ValidationError(e.detail);
      };
  
      document.addEventListener('wpcf7mailsent', onSuccess);
      document.addEventListener('wpcf7invalid', onError);
  
      // Trigger CF7 submit
      const submitBtn = formEl.querySelector('.wpcf7-submit');
      if (submitBtn) {
        submitBtn.click();
      } else {
        formEl.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
  
      // Fallback — if no CF7 events fire in 3s, assume generic form
      setTimeout(() => {
        if (WA.formState.active) {
          document.removeEventListener('wpcf7mailsent', onSuccess);
          document.removeEventListener('wpcf7invalid', onError);
          handleFormSubmitFallback();
        }
      }, 3000);
    };
  
    function finishFormFill() {
      WA.agentSay("All done! Your enquiry has been sent. I'll be in touch soon.");
      if (WA.formState.action) {
        WA.formState.action.status      = 'complete';
        WA.formState.action.completedAt = Date.now();
        WA.updateActionCardStatus(WA.formState.action.id, 'complete');
      }
      if (WA.formState.action?._resolveFormFill) {
        WA.formState.action._resolveFormFill();
      }
      resetFormState();
    }
  
    function handleCF7ValidationError(detail) {
      const failedInputs = document.querySelectorAll('.wpcf7-not-valid');
      if (failedInputs.length && WA.formState.action) {
        const failedNames = Array.from(failedInputs).map(el => el.getAttribute('name'));
        WA.formState.action.payload.fields.forEach(f => {
          if (failedNames.includes(f.name)) f.value = null;
        });
        WA.formState.active = true;
        handleFormInputAI('__RESUME__');
        return;
      }
      WA.agentSay("Some fields need correcting — please check the form.");
      WA.reconnectBridge();
    }
  
    function handleFormSubmitFallback() {
      WA.agentSay("The form is filled — please click the submit button to send your enquiry.");
      highlightSubmitButton();
      WA.reconnectBridge();
    }
  
    function highlightSubmitButton() {
      const btn = document.querySelector('.wpcf7-submit, [type="submit"], .btn-submit');
      if (btn) {
        btn.style.boxShadow = '0 0 0 3px rgba(200,75,47,0.5)';
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  
    // ─── CANCEL / ABANDON ─────────────────────────────────────────────────────
    WA.cancelFormFill = function() {
      if (WA.formState.action) {
        WA.formState.action.status      = 'denied';
        WA.formState.action.completedAt = Date.now();
        if (WA.formState.action._resolveFormFill) WA.formState.action._resolveFormFill();
      }
      WA.session.activeFormActionId = null;
      WA.saveSession();
      resetFormState();
      WA.setState('action', 'none');
      setTimeout(() => WA.reconnectBridge(), 800);
    };
  
    function abandonFormFill() {
      if (WA.formState.action) {
        WA.formState.action.status      = 'denied';
        WA.formState.action.completedAt = Date.now();
        if (WA.formState.action._resolveFormFill) WA.formState.action._resolveFormFill();
      }
      WA.session.activeFormActionId = null;
      document.querySelectorAll('.wa-filling').forEach(el => el.classList.remove('wa-filling'));
      WA.saveSession();
      resetFormState();
      WA.setState('action', 'none');
      setTimeout(() => WA.reconnectBridge(), 800);
    }
  
    function resetFormState() {
      WA.formState.active = false;
      WA.formState.action = null;
      _completeFormFillAttempts = 0;
      if (formAIController) { formAIController.abort(); formAIController = null; }
      WA.updateAbortButton();
    }
  
    function repopulateFields(action) {
      action.payload.fields.forEach(f => {
        if (f.value !== null) {
          const el = getFieldElement(f);
          if (el) fillField(el, f.value);
        }
      });
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
      const forms = WA.FORM_MAP || [];
      if (!forms.length) return;
      const form = forms[0].formEl;
      if (!form) return;
  
      const allInputs = form.querySelectorAll(
        `input[type="checkbox"][name="${field.name}"], input[type="checkbox"][name="${field.name}[]"],` +
        `input[type="radio"][name="${field.name}"], input[type="radio"][name="${field.name}[]"]`
      );
      allInputs.forEach(el => { el.checked = false; });
  
      selectedValues.forEach(val => {
        const el = form.querySelector(
          `input[name="${field.name}"][value="${val}"], input[name="${field.name}[]"][value="${val}"]`
        );
        if (el) {
          el.checked = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
  
      const firstEl = allInputs[0];
      if (firstEl) firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  
    WA.bus.emit('forms:ready');
    WA.log('Forms module loaded');
  
  })();