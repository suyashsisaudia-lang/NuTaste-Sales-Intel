/*
 * Voice input for the Ask boxes (Receivables and Secondary Sales).
 *
 * Adds a mic button to an Ask form. There is no language setting: the person
 * speaks English, Hindi, or the two mixed, and the model works out which from
 * the audio. The clip is recorded here as 16 kHz mono WAV — the one format every browser can
 * produce and every Gemini model accepts — and posted to /api/ask/transcribe.
 * The text comes back INTO the input box; the person reads it and presses Ask
 * themselves, so a misheard outlet name is corrected rather than answered.
 *
 * The controls stay hidden unless the server has voice switched on and the
 * browser will open a microphone, which it only does on HTTPS or localhost.
 */
(function () {
  'use strict';

  var TARGET_RATE = 16000;
  var LISTENING = 'Listening… tap the mic again to stop';
  var WORKING = 'Writing down your question…';
  var REASONS = {
    unheard: 'Nothing clear was heard. Try again a little closer to the mic.',
    empty: 'That was too short to hear. Hold on a moment longer before stopping.',
    'too-long': 'That clip was too long. Keep the question short.',
    rate: 'Too many questions in a short time. Wait a minute and try again.',
    quota: 'The voice service is busy right now. Type the question instead.',
    format: 'This browser sent audio the server could not read.',
    disabled: 'Voice input is switched off.',
    error: 'The question could not be transcribed. Try again, or type it.'
  };

  var MIC_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/>' +
    '<path d="M12 18v3"/></svg>';
  var STOP_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
    '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';

  var statusPromise = null;
  function getStatus() {
    if (!statusPromise) {
      statusPromise = fetch('/api/ask/status', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { return {}; });
    }
    return statusPromise;
  }

  function AudioCtx() { return window.AudioContext || window.webkitAudioContext; }

  function browserCanRecord() {
    return !!(window.isSecureContext && navigator.mediaDevices &&
              navigator.mediaDevices.getUserMedia && AudioCtx());
  }

  // ---- WAV encoding. Float32 samples at the device rate -> 16-bit PCM at 16 kHz.
  function downsample(buf, fromRate) {
    if (fromRate <= TARGET_RATE) return buf;
    var ratio = fromRate / TARGET_RATE;
    var out = new Float32Array(Math.floor(buf.length / ratio));
    for (var i = 0; i < out.length; i++) {
      // Average the source samples this output sample covers: a cheap low-pass
      // that stops high frequencies folding back in as noise.
      var start = Math.floor(i * ratio), end = Math.min(buf.length, Math.floor((i + 1) * ratio));
      var sum = 0;
      for (var j = start; j < end; j++) sum += buf[j];
      out[i] = sum / Math.max(1, end - start);
    }
    return out;
  }

  function encodeWav(samples) {
    var view = new DataView(new ArrayBuffer(44 + samples.length * 2));
    function str(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);   // PCM
    view.setUint16(22, 1, true);                                                  // mono
    view.setUint32(24, TARGET_RATE, true); view.setUint32(28, TARGET_RATE * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (var i = 0, off = 44; i < samples.length; i++, off += 2) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  // ---- one recorder per Ask box
  function attach(form, input, submitBtn) {
    if (!form || !input || form.querySelector('.askbox-mic')) return;

    var basePlaceholder = input.placeholder;
    var maxSeconds = 30, timeoutMs = 30000;
    var state = 'idle';          // idle | recording | working
    var rec = null;              // { ctx, stream, node, source, chunks, timer }

    var mic = document.createElement('button');
    mic.type = 'button';
    mic.className = 'askbox-mic';
    mic.hidden = true;

    var msg = document.createElement('div');
    msg.className = 'voice-msg';
    msg.setAttribute('role', 'status');
    msg.setAttribute('aria-live', 'polite');

    form.insertBefore(mic, submitBtn || null);
    form.parentNode.insertBefore(msg, form.nextSibling);

    function say(text) { msg.textContent = text || ''; msg.hidden = !text; }
    say('');

    function paint() {
      mic.classList.toggle('is-recording', state === 'recording');
      mic.classList.toggle('is-working', state === 'working');
      mic.disabled = state === 'working';
      mic.innerHTML = state === 'recording' ? STOP_SVG : MIC_SVG;
      var label = state === 'recording' ? 'Stop recording'
                : state === 'working' ? 'Transcribing'
                : 'Ask by voice (English or Hindi)';
      mic.title = label;
      mic.setAttribute('aria-label', label);
      mic.setAttribute('aria-pressed', state === 'recording' ? 'true' : 'false');

      input.placeholder = state === 'recording' ? LISTENING
                        : state === 'working' ? WORKING
                        : basePlaceholder;
    }

    function release() {
      if (!rec) return;
      clearTimeout(rec.timer);
      try { rec.node.disconnect(); rec.source.disconnect(); } catch (e) {}
      if (rec.stream) rec.stream.getTracks().forEach(function (t) { t.stop(); });
      try { rec.ctx.close(); } catch (e) {}
    }

    function start() {
      say('');
      var Ctx = AudioCtx();
      // Created inside the tap, before any await: iOS Safari only lets an
      // AudioContext run if it was started by the user's gesture.
      var ctx = new Ctx();
      if (ctx.resume) ctx.resume();
      rec = { ctx: ctx, chunks: [], stream: null };
      state = 'recording';
      paint();

      navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true,
                autoGainControl: true }
      }).then(function (stream) {
        if (!rec || rec.ctx !== ctx) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        rec.stream = stream;
        rec.source = ctx.createMediaStreamSource(stream);
        // ScriptProcessor is deprecated but is the one capture path that works
        // in every current browser without a separate worklet file.
        rec.node = ctx.createScriptProcessor(4096, 1, 1);
        rec.node.onaudioprocess = function (e) {
          rec.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        };
        rec.source.connect(rec.node);
        rec.node.connect(ctx.destination);   // output stays silent; required for Chrome to run it
        rec.timer = setTimeout(stop, maxSeconds * 1000);
      }).catch(function (err) {
        release(); rec = null; state = 'idle'; paint();
        var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        say(denied
          ? 'Microphone access was blocked. Allow it for this site in the browser, then try again.'
          : 'No microphone could be opened on this device.');
      });
    }

    function cancel() {
      if (state !== 'recording') return;
      release(); rec = null; state = 'idle'; paint();
    }

    function stop() {
      if (state !== 'recording' || !rec) return;
      var r = rec;
      var rate = r.ctx.sampleRate;
      release();
      rec = null;

      var total = 0;
      r.chunks.forEach(function (c) { total += c.length; });
      if (total < rate * 0.4) {
        state = 'idle'; paint();
        say(REASONS.empty);
        return;
      }
      var all = new Float32Array(total), off = 0;
      r.chunks.forEach(function (c) { all.set(c, off); off += c.length; });
      send(encodeWav(downsample(all, rate)));
    }

    function send(wav) {
      state = 'working'; paint();
      var fd = new FormData();
      fd.append('audio', wav, 'question.wav');
      var ctl = window.AbortController ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs) : null;

      fetch('/api/ask/transcribe', {
        method: 'POST', body: fd, credentials: 'same-origin',
        signal: ctl ? ctl.signal : undefined
      }).then(function (r) { return r.ok ? r.json() : { ok: false, reason: 'error' }; })
        .catch(function () { return { ok: false, reason: 'error' }; })
        .then(function (j) {
          if (timer) clearTimeout(timer);
          state = 'idle'; paint();
          if (j && j.ok && j.text) {
            input.value = j.text;
            say('Check the question, edit it if needed, then press Ask.');
            input.focus();
            try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
          } else {
            say(REASONS[(j && j.reason) || 'error'] || REASONS.error);
          }
        });
    }

    mic.addEventListener('click', function () {
      if (state === 'idle') start();
      else if (state === 'recording') stop();
    });
    // Sending the typed question, or pressing Escape, drops an unfinished clip.
    form.addEventListener('submit', cancel);
    form.addEventListener('keydown', function (e) { if (e.key === 'Escape') cancel(); });
    input.addEventListener('input', function () { if (msg.textContent) say(''); });

    paint();
    getStatus().then(function (s) {
      if (!s || !s.voice || !browserCanRecord()) return;
      if (s.voiceMaxSeconds > 0) maxSeconds = s.voiceMaxSeconds;
      if (s.voiceTimeoutMs > 0) timeoutMs = s.voiceTimeoutMs;
      mic.hidden = false;
    });
  }

  window.NTVoice = { attach: attach };
})();
