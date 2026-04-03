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
  let micState        = 'idle';
  let recognition     = null;
  let audioCtx        = null;
  let analyser        = null;
  let mediaStream     = null;
  let rafId           = null;
  let sampleInterval  = null;
  let finalTranscript = '';
  let onEndResolve    = null;   // resolves when recognition.onend fires

  // ── Scrolling waveform history ────────────────────────────────────────────────
  // Each entry is a normalised amplitude [0..1]. New values push in from the right;
  // old values shift off the left, creating a left-scrolling audio timeline.
  const BAR_W      = 2;    // px — bar width
  const BAR_GAP    = 1;    // px — gap between bars
  const BAR_SLOT   = BAR_W + BAR_GAP;
  const SAMPLE_MS  = 50;   // ms between amplitude samples (20 fps of history)
  const INIT_AMP   = 0.04; // height of "silent" bars before any speech

  let history = [];
  let maxBars = 0;

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
    if (micState === 'idle')           startRecording();
    else if (micState === 'recording') stopRecording();
    // 'transcribing' — button is disabled, clicks ignored
  }

  // ── Recording ────────────────────────────────────────────────────────────────
  async function startRecording() {
    const input   = $('wa-input');
    const canvas  = $('wa-mic-wave');
    const btn     = $('wa-mic');
    const sendBtn = $('wa-send');

    micState        = 'recording';
    finalTranscript = '';
    onEndResolve    = null;

    // Save and lock send button
    if (sendBtn) {
      sendBtn.dataset.micWasDisabled = sendBtn.disabled ? '1' : '0';
      sendBtn.disabled = true;
    }

    // Swap icon to stop square
    if (btn) {
      btn.innerHTML = STOP_SVG;
      btn.classList.add('wa-mic-recording');
      btn.setAttribute('aria-label', 'Finish — tap to send');
      btn.title = 'Finish — tap to send';
    }

    // Capture input dimensions before hiding it, then swap to canvas
    const inputW = input ? input.offsetWidth  : 220;
    const inputH = input ? input.offsetHeight : 38;

    maxBars = Math.floor(inputW / BAR_SLOT);
    history = new Array(maxBars).fill(INIT_AMP);

    if (input)  input.style.display = 'none';
    if (canvas) {
      canvas.style.display = 'block';
      canvas.width  = inputW;
      canvas.height = inputH;
    }

    // Configure speech recognition — continuous so only user stop ends it
    recognition = new SR();
    recognition.continuous     = true;
    recognition.interimResults = true;
    recognition.lang           = navigator.language || 'en-US';

    recognition.onresult = e => {
      finalTranscript = '';
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalTranscript += e.results[i][0].transcript;
      }
    };

    // Both onend and onerror resolve the same promise so stopRecording never hangs
    const resolveEnd = () => { if (onEndResolve) { onEndResolve(); onEndResolve = null; } };
    recognition.onend   = resolveEnd;
    recognition.onerror = e => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('[WA Mic] Speech error:', e.error);
      }
      resolveEnd();
    };

    recognition.start();

    // Start Web Audio pipeline (non-blocking — graceful fallback if denied)
    if (hasAudio && canvas) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        audioCtx    = new AC();
        analyser    = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        audioCtx.createMediaStreamSource(mediaStream).connect(analyser);
        startSampling();
      } catch (err) {
        console.warn('[WA Mic] Audio API unavailable:', err.message);
        // history stays flat — canvas will show the idle baseline
      }
    }

    // rAF draw loop (runs even without audio — shows the flat baseline)
    if (canvas) drawWaveform(canvas);
  }

  async function stopRecording() {
    if (micState !== 'recording' || !recognition) return;
    micState = 'transcribing';

    // Freeze the waveform and tear down audio immediately
    stopSampling();
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    stopAudioPipeline();

    // Swap canvas → transcribing UI
    const canvas = $('wa-mic-wave');
    if (canvas) canvas.style.display = 'none';
    showTranscribingUI();

    // Lock mic button during transcribing
    const btn = $('wa-mic');
    if (btn) {
      btn.classList.remove('wa-mic-recording');
      btn.classList.add('wa-mic-transcribing');
      btn.setAttribute('aria-label', 'Transcribing…');
      btn.title    = 'Transcribing…';
      btn.disabled = true;
    }

    // Wait for recognition to finish AND a minimum 1.5s display window
    const onEndPromise = new Promise(resolve => { onEndResolve = resolve; });
    const delayPromise = new Promise(resolve => setTimeout(resolve, 1500));

    recognition.stop(); // triggers onend → resolves onEndPromise

    await Promise.all([onEndPromise, delayPromise]);

    finishRecording();
  }

  function finishRecording() {
    micState = 'idle';

    const input   = $('wa-input');
    const btn     = $('wa-mic');
    const sendBtn = $('wa-send');

    // Hide transcribing UI, restore text input
    hideTranscribingUI();
    if (input) input.style.display = '';

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

  // ── Transcribing UI ───────────────────────────────────────────────────────────
  function showTranscribingUI() {
    let el = $('wa-mic-transcribing-ui');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wa-mic-transcribing-ui';
      el.innerHTML = `<span class="wa-mic-spinner" aria-hidden="true"></span><span>Transcribing…</span>`;
      // Insert in the same flex slot as the canvas
      const canvas = $('wa-mic-wave');
      if (canvas && canvas.parentNode) canvas.parentNode.insertBefore(el, canvas);
    }
    el.style.display = 'flex';
  }

  function hideTranscribingUI() {
    const el = $('wa-mic-transcribing-ui');
    if (el) el.style.display = 'none';
  }

  // ── Audio sampling ────────────────────────────────────────────────────────────
  // On each tick, push the current average amplitude into the history ring.
  // history.shift() drops the oldest bar off the left — everything scrolls left.
  function startSampling() {
    sampleInterval = setInterval(() => {
      if (!analyser) return;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((s, v) => s + v, 0) / (data.length * 255);
      history.push(avg);
      if (history.length > maxBars) history.shift();
    }, SAMPLE_MS);
  }

  function stopSampling() {
    if (sampleInterval) { clearInterval(sampleInterval); sampleInterval = null; }
  }

  // ── Audio cleanup ─────────────────────────────────────────────────────────────
  function stopAudioPipeline() {
    if (analyser)    { try { analyser.disconnect(); } catch (_) {} analyser = null; }
    if (audioCtx)    { audioCtx.close().catch(() => {}); audioCtx = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  }

  // ── Waveform renderer ─────────────────────────────────────────────────────────
  // Draws the current history array as thin vertical bars, left-to-right.
  // Because startSampling() pushes new bars onto the right and shifts old ones
  // off the left, the result is a scrolling audio timeline.
  function drawWaveform(canvas) {
    const ctx  = canvas.getContext('2d');

    function frame() {
      rafId = requestAnimationFrame(frame);

      const w    = canvas.width;
      const h    = canvas.height;
      const maxH = h * 0.82;
      const minH = 2;

      ctx.clearRect(0, 0, w, h);

      for (let i = 0; i < history.length; i++) {
        const val = history[i];
        // Boost and square the amplitude so quiet barely shows and loud speech
        // towers — creates the dramatic height contrast the eye expects.
        const shaped = Math.pow(Math.min(1, val * 2.8), 2);
        const barH   = Math.max(minH, shaped * maxH);
        const x      = i * BAR_SLOT;
        const y      = (h - barH) / 2;
        // --wa-text is rgba(20,20,18,0.92) — use its RGB, vary alpha with amplitude
        ctx.fillStyle = `rgba(20,20,18,${0.12 + shaped * 0.80})`;
        ctx.fillRect(x, y, BAR_W, barH);
      }
    }

    frame();
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  WA.mic = { init };

})();
