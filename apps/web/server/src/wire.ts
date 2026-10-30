// Browser <-> gateway audio framing, shared by both sides. GPT-Live itself still receives
// base64 PCM16; only the long, often lossy browser link uses this compact form.
// Binary frame: one type byte, then G.711 mu-law samples at 24 kHz mono.
export const FRAME_AUDIO = 1;
export const FRAME_HEARTBEAT = 2;

const BIAS = 0x84, CLIP = 32635;

export function encodeMulaw(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let sample = pcm[i]!;
    const sign = sample < 0 ? 0x80 : 0;
    if (sign) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

export function decodeMulaw(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const value = ~bytes[i]! & 0xff;
    const exponent = (value >> 4) & 0x07, mantissa = value & 0x0f;
    const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
    out[i] = value & 0x80 ? -magnitude : magnitude;
  }
  return out;
}

export function frame(type: number, payload?: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(1 + (payload?.length ?? 0));
  out[0] = type;
  if (payload) out.set(payload, 1);
  return out;
}

/** True when a PCM16 chunk carries no audible signal; GPT-Live streams digital silence between turns. */
export function isSilent(pcm: Int16Array, peakLimit = 8): boolean {
  for (let i = 0; i < pcm.length; i++) if (pcm[i]! > peakLimit || pcm[i]! < -peakLimit) return false;
  return true;
}
