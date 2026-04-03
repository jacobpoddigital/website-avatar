/**
 * features/mic.js — Voice-to-text input
 * Web Speech API transcription + Web Audio API waveform visualisation.
 * Integrates with the existing .wa-input-row without touching other modules.
 */

(function () {

  const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const AC = window.AudioContext      || window.webkitAudioContext;

  const hasSpeech = !!SR;
  const hasAudio  = !!AC;

  // ── State ────────────────────────────────────────────────────────────────────
  // 'idle' | 'recording' | 'transcribing'
  let micState       = 'idle';
  let recognition    = null;
  let audioCtx       = null;
  let analyser       = null;
  let mediaStream    = null;
  let rafId          = null;
  let finalTranscript = '';

  // ── DOM helpers ──────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  const MIC_SVG  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
  const STOP_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>`;

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    const btn = $('wa-mic');
    if (!btn) return;

    if (!hasSpeech) {
      btn.disabled = true;
      btn.title    = 'Voice input is not supported in this browser';
      btn.style.opacity = '0.25';
      return;
    }

    btn.addEventListener('click', onMicClick);
  }

  function onMicClick() {
    if (micState === 'idle')      startRecording();
    else if (micState === 'recording') stopRecording();
    // 'transcribing' — ignore clicks until done
  }

  // ── Recording ────────────────────────────────────────────────────────────────
  async function startRecording() {
    const input   = $('wa-input');
    const canvas  = $('wa-mic-wave');
    const btn     = $('wa-mic');
    const sendBtn = $('wa-send');

    micState        = 'recording';
    finalTranscript = '';

    // Save and lock send button
    if (sendBtn) {
      sendBtn.dataset.micWasDisabled = sendBtn.disabled ? '1' : '0';
      sendBtn.disabled = true;
    }

    // Swap icon to stop square and mark as recording
    if (btn) {
      btn.innerHTML = STOP_SVG;
      btn.classList.add('wa-mic-recording');
      btn.setAttribute('aria-label', 'Finish — tap to send');
      btn.title = 'Finish — tap to send';
    }

    // Capture input dimensions before hiding it
    const inputW = input ? input.offsetWidth  : 220;
    const inputH = input ? input.offsetHeight : 38;

    // Swap: hide text input, show waveform canvas
    if (input)  input.style.display = 'none';
    if (canvas) {
      canvas.style.display = 'block';
      canvas.width  = inputW;
      canvas.height = inputH;
    }

    // Start speech recognition
    recognition = new SR();
    recognition.continuous      = true;   // only stops when user clicks stop
    recognition.interimResults  = true;
    recognition.lang            = navigator.language || 'en-US';

    recognition.onresult = e => {
      finalTranscript = '';
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalTranscript += e.results[i][0].transcript;
        }
      }
    };

    recognition.onend   = finishRecording;
    recognition.onerror = e => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('[WA Mic] Speech recognition error:', e.error);
      }
      finishRecording();
    };

    recognition.start();

    // Start Web Audio waveform (non-blocking — graceful fallback if denied)
    if (hasAudio && canvas) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        audioCtx  = new AC();
        analyser  = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        audioCtx.createMediaStreamSource(mediaStream).connect(analyser);
        drawWaveform(canvas);
      } catch (err) {
        // Mic permission denied or unavailable — speech recognition continues
        console.warn('[WA Mic] Audio API unavailable:', err.message);
      }
    }
  }

  function stopRecording() {
    if (micState !== 'recording' || !recognition) return;
    micState = 'transcribing';

    const btn = $('wa-mic');
    if (btn) {
      btn.innerHTML = STOP_SVG;
      btn.classList.remove('wa-mic-recording');
      btn.classList.add('wa-mic-transcribing');
      btn.setAttribute('aria-label', 'Transcribing…');
      btn.title = 'Transcribing…';
      btn.disabled = true;
    }

    recognition.stop(); // triggers onend → finishRecording
  }

  function finishRecording() {
    micState = 'idle';
    stopAudioPipeline();

    const input   = $('wa-input');
    const canvas  = $('wa-mic-wave');
    const btn     = $('wa-mic');
    const sendBtn = $('wa-send');

    // Restore layout
    if (canvas) canvas.style.display = 'none';
    if (input)  input.style.display  = '';

    // Drop transcript into input field
    if (finalTranscript && input) {
      input.value = finalTranscript.trim();
      input.focus();
    }

    // Reset mic button back to mic icon
    if (btn) {
      btn.innerHTML = MIC_SVG;
      btn.classList.remove('wa-mic-recording', 'wa-mic-transcribing');
      btn.disabled = false;
      btn.setAttribute('aria-label', 'Voice input');
      btn.title = 'Voice input';
    }

    // Restore send button to its pre-recording state
    if (sendBtn) {
      sendBtn.disabled = sendBtn.dataset.micWasDisabled === '1';
      delete sendBtn.dataset.micWasDisabled;
    }

    recognition = null;
  }

  // ── Audio cleanup ─────────────────────────────────────────────────────────────
  function stopAudioPipeline() {
    if (rafId)       { cancelAnimationFrame(rafId); rafId = null; }
    if (analyser)    { try { analyser.disconnect(); } catch (_) {} analyser = null; }
    if (audioCtx)    { audioCtx.close().catch(() => {}); audioCtx = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  }

  // ── Waveform renderer ─────────────────────────────────────────────────────────
  function drawWaveform(canvas) {
    const ctx         = canvas.getContext('2d');
    const binCount    = analyser.frequencyBinCount; // fftSize / 2 = 32
    const data        = new Uint8Array(binCount);
    const barCount    = Math.min(binCount, 20);

    function frame() {
      rafId = requestAnimationFrame(frame);
      if (!analyser) return;

      analyser.getByteFrequencyData(data);

      const w      = canvas.width;
      const h      = canvas.height;
      const slot   = w / barCount;
      const barW   = slot * 0.55;
      const gap    = slot * 0.45;
      const maxH   = h * 0.80;
      const minH   = 3;
      const radius = barW / 2;

      ctx.clearRect(0, 0, w, h);

      for (let i = 0; i < barCount; i++) {
        const val  = data[i] / 255;
        const barH = Math.max(minH, val * maxH);
        const x    = i * slot + gap / 2;
        const y    = (h - barH) / 2;

        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(x, y, barW, barH, radius);
        } else {
          // Fallback for older browsers
          ctx.rect(x, y, barW, barH);
        }
        ctx.fillStyle = `rgba(60,130,246,${0.35 + val * 0.65})`;
        ctx.fill();
      }
    }

    frame();
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  // Runs after DOM is ready; the elements already exist because website-avatar.js
  // calls injectHTML before loading this script.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  WA.mic = { init };

})();
