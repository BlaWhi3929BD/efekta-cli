// Efekta Bridge - MAIN World Injected Script
// Hooks WebRTC getUserMedia to provide speech-modulated synthetic audio
// and provides media inspection helpers without leaking AudioContexts.
(function () {
  if (window.__efekta_injected_loaded) return;
  window.__efekta_injected_loaded = true;

  window.__efekta_mock_audio_active = true;

  // Create a speech-modulated audio stream that triggers VAD (Voice Activity Detection)
  // and immediately fails ASR (Automatic Speech Recognition) without hanging on silence.
  function createSyntheticSpeechStream() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;

      const ctx = new AudioCtx();
      const dest = ctx.createMediaStreamDestination();

      // Carrier oscillator (human fundamental frequency range: 130Hz - 260Hz)
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(165, ctx.currentTime);

      // Formant filter to resemble vocal tract energy so VAD triggers immediately
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(800, ctx.currentTime);
      filter.Q.setValueAtTime(2.5, ctx.currentTime);

      // White noise buffer for consonant-like energy
      const bufferSize = ctx.sampleRate * 2;
      const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }
      const whiteNoise = ctx.createBufferSource();
      whiteNoise.buffer = noiseBuffer;
      whiteNoise.loop = true;

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.08, ctx.currentTime);

      // Master envelope gain modulated like syllables (bursts for 1.1s, then silence so VAD ends)
      const masterGain = ctx.createGain();
      const now = ctx.currentTime;
      masterGain.gain.setValueAtTime(0.01, now);
      // 3 distinct syllable bursts followed by silence
      masterGain.gain.linearRampToValueAtTime(0.35, now + 0.08);
      masterGain.gain.linearRampToValueAtTime(0.05, now + 0.30);
      masterGain.gain.linearRampToValueAtTime(0.40, now + 0.40);
      masterGain.gain.linearRampToValueAtTime(0.04, now + 0.65);
      masterGain.gain.linearRampToValueAtTime(0.30, now + 0.75);
      masterGain.gain.linearRampToValueAtTime(0.001, now + 1.05);

      osc. frequency.linearRampToValueAtTime(210, now + 0.35);
      osc.frequency.linearRampToValueAtTime(140, now + 0.70);
      osc.frequency.linearRampToValueAtTime(190, now + 1.00);

      osc.connect(filter);
      filter.connect(masterGain);
      whiteNoise.connect(noiseGain);
      noiseGain.connect(masterGain);
      masterGain.connect(dest);

      osc.start();
      whiteNoise.start();

      const stream = dest.stream;

      // Prevent AudioContext leak when Efekta stops the microphone track
      const cleanup = () => {
        try {
          osc.stop();
          whiteNoise.stop();
          if (ctx.state !== "closed") {
            ctx.close();
          }
        } catch (_) {}
      };

      stream.getTracks().forEach((track) => {
        const origStop = track.stop.bind(track);
        track.stop = function () {
          cleanup();
          return origStop();
        };
        track.addEventListener("ended", cleanup);
      });

      // Auto-cleanup after 8s max even if caller forgets to stop track
      setTimeout(cleanup, 8000);

      return stream;
    } catch (e) {
      console.warn("[Efekta-Bridge] Failed to synthesize audio stream:", e);
      return null;
    }
  }

  // Hook navigator.mediaDevices.getUserMedia
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      if (window.__efekta_mock_audio_active && constraints && constraints.audio) {
        const synthetic = createSyntheticSpeechStream();
        if (synthetic) {
          // If video was also requested (rare), merge or return synthetic
          return synthetic;
        }
      }
      return originalGetUserMedia(constraints);
    };
  }

  // Listen for toggle configuration from content script
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "efekta-content") return;
    if (event.data.type === "SET_AUDIO_MOCK") {
      window.__efekta_mock_audio_active = !!event.data.enabled;
    }
  });
})();
