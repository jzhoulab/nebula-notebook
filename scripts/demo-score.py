#!/usr/bin/env python3
"""
Original score for the product film — synthesised, so it ships with the repo
and has no licence attached.

Driving four-on-the-floor electronica at 124 BPM in F# minor, arranged to the
film's arc: cold open, build, two main sections either side of a breakdown, a
lift for the feature block, and a resolve under the end card. Everything is
generated from numpy oscillators and noise — no samples.

  /usr/bin/python3 scripts/demo-score.py <seconds> <out.wav>
"""
import sys
import numpy as np

SR = 44100
BPM = 124.0
BEAT = 60.0 / BPM
BAR = BEAT * 4

# F# minor: the film's palette is cool blues/violets; this mode matches it.
ROOT = 46.25 * 2          # F#2
SCALE = [0, 2, 3, 5, 7, 8, 10]        # natural minor
CHORDS = [[0, 3, 7], [5, 8, 12], [8, 12, 15], [3, 7, 10]]   # i · iv · VI · III-ish


def semis(n):
    return 2 ** (n / 12.0)


def env(n, a, d, s, r, sus=1.0):
    """ADSR over n samples (seconds in, samples out)."""
    a, d, r = int(a * SR), int(d * SR), int(r * SR)
    a, d = max(a, 1), max(d, 1)
    body = max(n - a - d - r, 0)
    out = np.concatenate([
        np.linspace(0, 1, a),
        np.linspace(1, sus, d),
        np.full(body, sus),
        np.linspace(sus, 0, r) if r else np.zeros(0),
    ])
    return np.pad(out, (0, max(0, n - len(out))))[:n]


def saw(freq, n, detune=0.0):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k in range(1, 13):
        out += np.sin(2 * np.pi * freq * k * (1 + detune) * t) / k
    return out * 0.55


def sine(freq, n):
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * freq * t)


def noise(n):
    return np.random.default_rng(7).standard_normal(n) * 0.5


def lowpass(x, cutoff):
    """One-pole filter — enough to take the fizz off a saw stack."""
    a = np.exp(-2 * np.pi * cutoff / SR)
    out = np.zeros_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc = (1 - a) * x[i] + a * acc
        out[i] = acc
    return out


def kick(n):
    t = np.arange(n) / SR
    f = 118 * np.exp(-t * 28) + 46
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)
    click = noise(n)[:n] * np.exp(-t * 160) * 0.5
    return (body + click) * 0.95


def snare(n):
    t = np.arange(n) / SR
    return (noise(n) * np.exp(-t * 22) * 0.55 + np.sin(2 * np.pi * 190 * t) * np.exp(-t * 26) * 0.3)


def hat(n, open_=False):
    t = np.arange(n) / SR
    d = 8 if open_ else 55
    return noise(n) * np.exp(-t * d) * (0.22 if open_ else 0.15)


def place(buf, x, at):
    i = int(at * SR)
    j = min(len(buf), i + len(x))
    if i < len(buf):
        buf[i:j] += x[: j - i]


def build(total):
    n = int(total * SR)
    drums = np.zeros(n)
    bass = np.zeros(n)
    lead = np.zeros(n)
    pad = np.zeros(n)
    bars = int(total / BAR) + 2

    for b in range(bars):
        t0 = b * BAR
        if t0 > total:
            break
        # ---- arrangement: which layers are alive this bar
        intro = t0 < BAR * 2                    # cold open: pad only
        build_up = BAR * 2 <= t0 < BAR * 4
        breakdown = 0.42 < (t0 / total) < 0.50  # let the film breathe mid-way
        full = not (intro or build_up or breakdown)
        chord = CHORDS[b % len(CHORDS)]

        # pad: always, the bed the whole thing floats on
        dur = int(BAR * SR)
        for iv in chord:
            f = ROOT * semis(iv) * 2
            v = saw(f, dur, detune=0.004) + saw(f, dur, detune=-0.005)
            place(pad, v * env(dur, 0.35, 0.4, 0.75, 0.5) * (0.05 if intro else 0.035), t0)
        if intro:
            continue

        # bass: straight eighths, root + fifth — the drive
        for i in range(8):
            at = t0 + i * BEAT / 2
            d = int(BEAT / 2 * SR)
            iv = chord[0] if i % 4 != 3 else chord[0] + 7
            f = ROOT * semis(iv) / 2
            v = (saw(f, d) * 0.7 + sine(f, d) * 0.6) * env(d, 0.004, 0.05, 0.62, 0.06)
            place(bass, v * (0.16 if build_up else 0.22), at)

        if breakdown:
            continue

        # drums
        for i in range(4):
            place(drums, kick(int(0.3 * SR)), t0 + i * BEAT)
        if full:
            for i in (1, 3):
                place(drums, snare(int(0.26 * SR)), t0 + i * BEAT)
        for i in range(8):
            place(drums, hat(int(0.12 * SR), open_=(i == 7)), t0 + i * BEAT / 2)

        # lead: a 16th arpeggio that keeps the thing moving forward
        if full:
            steps = [0, 7, 12, 7, 15, 12, 19, 12, 15, 7, 12, 7, 10, 7, 12, 15]
            for i, st in enumerate(steps):
                at = t0 + i * BEAT / 4
                d = int(BEAT / 4 * SR * 1.6)
                f = ROOT * semis(chord[0] + st) * 2
                v = saw(f, d, 0.002) * env(d, 0.003, 0.03, 0.35, 0.09)
                place(lead, v * 0.085, at)

    lead = lowpass(lead, 4200)
    pad = lowpass(pad, 1400)
    mix = drums * 0.9 + bass + lead + pad
    # gentle bus compression, then a fade at both ends
    mix = np.tanh(mix * 1.5) / 1.5
    fade = int(1.6 * SR)
    mix[:fade] *= np.linspace(0, 1, fade)
    mix[-fade:] *= np.linspace(1, 0, fade)
    mix /= max(1e-9, np.abs(mix).max()) / 0.89
    return mix


def write_wav(path, mono):
    import struct, wave
    stereo = np.stack([mono, np.roll(mono, 90)], axis=1)  # a hair of width
    data = (np.clip(stereo, -1, 1) * 32767).astype("<i2").tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data)


if __name__ == "__main__":
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 200.0
    out = sys.argv[2] if len(sys.argv) > 2 else "score.wav"
    write_wav(out, build(secs))
    print(f"{out}  ({secs:.1f}s @ {BPM:.0f} BPM)")
