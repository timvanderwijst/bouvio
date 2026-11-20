// Recorded audio → 16 kHz mono 16-bit PCM WAV, the format whisper.cpp reads
// directly and OpenAI accepts too.

const RATE = 16_000;

/** A 44-byte RIFF/WAVE header for 16-bit PCM. */
export function wavHeader(rate: number, channels: number, dataLength: number): ArrayBuffer {
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  const block = channels * 2;
  text(0, "RIFF");
  v.setUint32(4, 36 + dataLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * block, true);
  v.setUint16(32, block, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, dataLength, true);
  return buf;
}

/** Float samples in [-1, 1] → little-endian 16-bit PCM. */
export function toPcm16(samples: Float32Array): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out.buffer;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

/**
 * Decode any recording the browser can play (webm/opus, ogg, mp4, wav), mix it
 * to mono and resample it to 16 kHz, and return a 16-bit PCM WAV as base64.
 */
export async function toWav16k(blob: Blob): Promise<string> {
  const data = await blob.arrayBuffer();
  const Ctx: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data);
  } finally {
    void ctx.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * RATE));
  // A mono destination down-mixes every channel; the context resamples.
  const off = new OfflineAudioContext(1, frames, RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const pcm = toPcm16(rendered.getChannelData(0));
  const wav = new Uint8Array(44 + pcm.byteLength);
  wav.set(new Uint8Array(wavHeader(RATE, 1, pcm.byteLength)), 0);
  wav.set(new Uint8Array(pcm), 44);
  return toBase64(wav);
}
