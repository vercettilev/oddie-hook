"""The launch score: darksynth into a phonk drop, 150 BPM in F minor, synthesized from
nothing (no samples, nothing to license).

    python3 build_audio.py out.wav

Needs numpy and scipy. Every hit comes from timeline.json, the same file teaser.html reads,
so each cut in the picture lands on its beat.
"""
import json
import sys
import wave
from pathlib import Path

import numpy as np
from scipy import signal

HERE = Path(__file__).resolve().parent
TL = json.loads((HERE / "timeline.json").read_text())
SR = 48000
BEAT = 60 / TL["bpm"]
BARS = TL["bars"]
DUR = BARS["end"] * 4 * BEAT
N = int(round(DUR * SR)) + SR  # a second of tail room, trimmed at the end
rng = np.random.default_rng(150)


def at(beat):
    return beat * BEAT


def bar_t(bar, beat=0.0):
    return at(bar * 4 + beat)


def ns(sec):
    return int(round(sec * SR))


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


class Bus:
    def __init__(self):
        self.x = np.zeros((N, 2))

    def add(self, sig, t, gain=1.0, pan=0.0):
        i = ns(t)
        if i >= N or gain == 0:
            return
        sig = np.asarray(sig, float)
        if sig.ndim == 1:
            a = (pan + 1) * np.pi / 4
            sig = np.stack([sig * np.cos(a), sig * np.sin(a)], axis=1) * np.sqrt(2)
        sig = sig[: N - i]
        self.x[i : i + len(sig)] += sig * gain


# ---------- filters ----------
def _sos(kind, f, order=2):
    return signal.butter(order, f, btype=kind, fs=SR, output="sos")


def lp(x, f, order=2):
    return signal.sosfilt(_sos("lowpass", min(f, SR * 0.45), order), x, axis=0)


def hp(x, f, order=2):
    return signal.sosfilt(_sos("highpass", f, order), x, axis=0)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(_sos("bandpass", [lo, min(hi, SR * 0.45)], order), x, axis=0)


def sweep(x, f0, f1, kind="lowpass", shape=1.0, block=256):
    """A filter whose cutoff glides geometrically from f0 to f1 across x."""
    y = np.empty_like(x)
    zi = None
    n = len(x)
    for s in range(0, n, block):
        e = min(n, s + block)
        p = ((s + e) / 2 / n) ** shape
        sos = _sos(kind, float(np.clip(f0 * (f1 / f0) ** p, 20, SR * 0.45)))
        if zi is None:
            zi = np.zeros((sos.shape[0], 2) + x.shape[1:])
        y[s:e], zi = signal.sosfilt(sos, x[s:e], axis=0, zi=zi)
    return y


# ---------- envelopes, oscillators ----------
def ad(n, a, d):
    t = np.arange(n) / SR
    return np.minimum(1, t / max(a, 1e-5)) * np.exp(-t / d)


def gate(n, a=0.004, r=0.04):
    e = np.ones(n)
    na, nr = min(n, ns(a)), min(n, ns(r))
    if na:
        e[:na] = np.linspace(0, 1, na)
    if nr:
        e[-nr:] *= np.linspace(1, 0, nr)
    return e


def cut(sig, at_sec, fade=0.02):
    sig = np.array(sig, float)
    i, f = ns(at_sec), ns(fade)
    sig[i:] = 0
    sig[max(0, i - f) : i] *= np.linspace(1, 0, i - max(0, i - f)).reshape((-1,) + (1,) * (sig.ndim - 1))
    return sig


def _blep(ph, dt):
    y = np.zeros_like(ph)
    m = ph < dt
    x = ph[m] / dt[m]
    y[m] = x + x - x * x - 1
    m = ph > 1 - dt
    x = (ph[m] - 1) / dt[m]
    y[m] = x * x + x + x + 1
    return y


def saw(freq, n, phase=None):
    dt = np.broadcast_to(np.asarray(freq, float), (n,)) / SR
    ph = ((rng.random() if phase is None else phase) + np.cumsum(dt)) % 1.0
    return 2 * ph - 1 - _blep(ph, dt)


def sine(freq, n, phase=0.0):
    f = np.broadcast_to(np.asarray(freq, float), (n,))
    return np.sin(2 * np.pi * (phase + np.cumsum(f) / SR))


def supersaw(notes, n, voices=7, cents=24, spread=0.85):
    out = np.zeros((n, 2))
    for m in notes:
        for v in range(voices):
            k = (v - (voices - 1) / 2) / ((voices - 1) / 2)
            s = saw(hz(m) * 2 ** (k * cents / 1200), n)
            a = (k * spread + 1) * np.pi / 4
            out[:, 0] += s * np.cos(a)
            out[:, 1] += s * np.sin(a)
    return out / np.sqrt(voices * len(notes))


def noise(n):
    return rng.standard_normal(n)


def reverb_ir(seconds=2.3, damp=5500):
    n = ns(seconds)
    t = np.arange(n) / SR
    ir = np.stack([noise(n), noise(n)], axis=1) * np.exp(-t / (seconds / 6.5))[:, None]
    ir = lp(ir, damp)
    ir[: ns(0.015)] = 0
    return ir / np.sqrt(np.sum(ir ** 2) / 2)


# ---------- drums ----------
def kick(length=0.42, drive=2.0):
    n = ns(length)
    t = np.arange(n) / SR
    f = 47 + 200 * np.exp(-t * 34) + 45 * np.exp(-t * 9)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * ad(n, 0.0012, 0.18)
    click = hp(noise(n), 3000) * ad(n, 0.0002, 0.004) * 0.5
    return np.tanh(drive * body + click) * gate(n, 0.0005, 0.03)


def heartbeat():
    n = ns(0.35)
    t = np.arange(n) / SR
    f = 38 + 60 * np.exp(-t * 30)
    return lp(np.sin(2 * np.pi * np.cumsum(f) / SR) * ad(n, 0.004, 0.11), 180)


def clap():
    n = ns(0.45)
    x, out = noise(n), np.zeros(n)
    for i, d in enumerate([0, 0.010, 0.021, 0.032]):
        s = ns(d)
        out[s:] += x[: n - s] * ad(n - s, 0.0005, 0.007 if i < 3 else 0.10)
    return bp(out, 950, 5500) * 1.4


def snare(tone=190, length=0.28):
    n = ns(length)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * np.cumsum(tone * (1 + 0.5 * np.exp(-t * 45))) / SR) * ad(n, 0.0008, 0.055)
    nz = bp(noise(n), 1400, 9500) * ad(n, 0.0008, 0.10)
    return np.tanh(1.6 * (0.8 * body + nz))


def hat(open_=False):
    n = ns(0.32 if open_ else 0.05)
    return hp(noise(n), 7200, 4) * ad(n, 0.0004, 0.10 if open_ else 0.014)


def crash(length=2.8):
    n = ns(length)
    t = np.arange(n) / SR
    ring = sum(np.sin(2 * np.pi * f * t + rng.random() * 6) for f in (3170, 4425, 5310, 6880, 8120)) * 0.06
    return hp(noise(n) + ring, 3800, 2) * ad(n, 0.0015, length * 0.33)


_GATE_IR = reverb_ir(1.4, 6500)


def gated_snare():
    """The 80s snare: a big room cut dead after a quarter second."""
    s, n = snare(215, 0.3), ns(0.5)
    dry = np.zeros(n)
    dry[: len(s)] = s
    wet = signal.fftconvolve(np.stack([dry, dry], 1), _GATE_IR, axes=0)[:n] * 0.85
    g = np.ones(n)
    c0, f = ns(0.22), ns(0.03)
    g[c0 : c0 + f] = np.linspace(1, 0, f)
    g[c0 + f :] = 0
    return np.stack([dry, dry], 1) * 0.9 + wet * g[:, None]


GATED = gated_snare()


# ---------- tone ----------
def b808(m, length, glide=0, drive=2.8):
    """A phonk 808: a sine with a punch, driven hard; glide starts it that many semitones up."""
    n = ns(length)
    t = np.arange(n) / SR
    f = hz(m) * (1 + 0.9 * np.exp(-t * 45))
    if glide:
        f = f * 2 ** (glide / 12 * (1 - np.clip(t / (length * 0.7), 0, 1)))
    x = np.tanh(drive * np.sin(2 * np.pi * np.cumsum(f) / SR)) * ad(n, 0.002, max(0.3, length)) * gate(n, 0.001, 0.025)
    return lp(x, 1800)


def cowbell(m, length=0.24):
    """The 808 cowbell, two detuned squares, pitched to play the hook."""
    n = ns(length)
    f = hz(m)
    x = 0.6 * np.sign(sine(f, n)) + 0.4 * np.sign(sine(f * 1.4815, n))
    x = bp(x, f * 0.85, min(f * 4.5, 15000))
    e = 0.7 * ad(n, 0.0004, 0.04) + 0.35 * ad(n, 0.0004, 0.15)
    return np.tanh(2.2 * x * e)


def boom(length=2.4, f0=78, f1=29):
    n = ns(length)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t * 2.4)
    return np.tanh(1.8 * np.sin(2 * np.pi * np.cumsum(f) / SR)) * ad(n, 0.002, length * 0.36)


def impact(length=1.4):
    n = ns(length)
    return lp(noise(n), 1800, 2) * ad(n, 0.0008, 0.20)


def zap():
    n = ns(0.16)
    t = np.arange(n) / SR
    f = 160 + 1900 * np.exp(-t * 28)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * ad(n, 0.0005, 0.05)


def pop():
    n = ns(0.09)
    t = np.arange(n) / SR
    f = 330 + 900 * (1 - np.exp(-t * 60))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * ad(n, 0.0006, 0.028)


def blip(m, length=0.05):
    n = ns(length)
    return (np.sign(sine(hz(m), n)) * 0.5 + sine(hz(m) * 2, n) * 0.5) * ad(n, 0.0004, 0.012)


def tick():
    n = ns(0.025)
    return bp(noise(n), 2200, 7500) * ad(n, 0.0002, 0.0035) + sine(1500 + rng.random() * 600, n) * ad(n, 0.0002, 0.0025) * 0.4


def glitch(length=0.11):
    """A bit-crushed burst: stepped square tones over held noise."""
    n = ns(length)
    step = ns(0.007)
    f = np.repeat(rng.choice([140, 280, 560, 1120, 2240, 4480], size=n // step + 1), step)[:n]
    held = np.repeat(noise(n // 24 + 1), 24)[:n]
    return np.tanh(1.5 * (0.6 * np.sign(sine(f, n)) + 0.5 * held)) * gate(n, 0.002, 0.02)


def reverse_swell(length):
    c = crash(length + 0.6)[: ns(length)][::-1]
    return c * np.linspace(0, 1, len(c)) ** 1.5


def whoosh(length):
    n = ns(length)
    return sweep(noise(n), 400, 9000, "lowpass", shape=1.4) * np.linspace(0, 1, n) ** 2


def stab(chord, length=0.15, attack=0.002):
    n = ns(length + 0.3)
    x = supersaw(chord, n) * ad(n, attack, length * 0.9)[:, None]
    return sweep(x, 9500, 1600, "lowpass", shape=0.6)


def pad(chord, length, cutoff=1800, voices=5):
    n = ns(length)
    return lp(supersaw(chord, n, voices=voices, cents=14) * gate(n, 0.25, 0.4)[:, None], cutoff)


def pluck(m, length=0.14, cutoff=4200):
    n = ns(length)
    return lp((saw(hz(m), n) + saw(hz(m) * 1.004, n)) * 0.5, cutoff) * ad(n, 0.002, 0.07)


def bass_note(m, length, drive=2.4, cutoff=1100):
    n = ns(length)
    mid = (saw(hz(m + 12), n) + saw(hz(m + 12) * 1.008, n) + saw(hz(m + 12) * 0.992, n)) / 3
    return (0.55 * lp(np.tanh(drive * mid), cutoff) + 0.8 * sine(hz(m), n)) * gate(n, 0.004, 0.03)


def neon_buzz(length=1.4, settle=0.1):
    """A sign coming on: 100 Hz mains hum and crackle, gated by the same flicker as the picture."""
    n = ns(length)
    t = np.arange(n) / SR
    hum = bp(sum(np.sin(2 * np.pi * 100 * k * t + k * 0.7) / k ** 0.8 for k in range(1, 16)), 120, 4000)
    crk = bp(noise(n) * (rng.random(n) < 0.03) * 3, 1500, 9000)
    g = np.zeros(n)
    for a, b in TL["flicker"]:
        if ns(a) < n:
            g[ns(a) : min(n, ns(b))] = 1
    last = ns(TL["flicker"][-1][0])
    k = np.arange(n - last) / SR
    g[last:] = settle + (1 - settle) * np.exp(-k / 0.18)
    g = np.convolve(g, np.ones(96) / 96, mode="same")
    out = (0.4 * hum + 0.7 * crk) * g
    for a, _ in TL["flicker"]:
        i = ns(a)
        if i < n:
            z = zap()[: n - i] * 0.35
            out[i : i + len(z)] += z
    return out * gate(n, 0.001, 0.3)


def rain_bed(length):
    n = ns(length)
    x = np.stack([noise(n), noise(n)], 1)
    x = bp(x, 500, 8000) * 0.5 + lp(x, 700) * 0.1
    drops = np.zeros((n, 2))
    for _ in range(int(length * 45)):
        i = int(rng.integers(0, n - 400))
        drops[i : i + 300, int(rng.integers(0, 2))] += ad(300, 0.0002, 0.0012) * rng.uniform(0.3, 1.0)
    return (x + bp(drops, 2000, 9000) * 2.5) * gate(n, 0.4, 0.4)[:, None]


def crackle(length=0.3):
    n = ns(length)
    x = np.zeros(n)
    for _ in range(int(length * 260)):
        i = int(rng.integers(0, n - 200))
        x[i : i + 120] += ad(120, 0.00005, 0.0006) * rng.uniform(0.2, 1) * rng.choice([-1, 1])
    return bp(x, 1800, 9000) * np.linspace(0.3, 1, n)


def breath(length=0.35):
    n = ns(length)
    return sweep(noise(n), 600, 3500, "lowpass") * np.sin(np.linspace(0, np.pi, n)) ** 1.5


def pingpong(x, delay, fb=0.45, taps=5):
    """A ping-pong echo, as a short impulse response."""
    n = ns(delay) * taps + 1
    ir = np.zeros((n, 2))
    ir[0] = 1
    for k in range(1, taps):
        ir[ns(delay) * k, k % 2] = fb ** k
    return signal.fftconvolve(x, ir, axes=0)[: len(x)]


# ---------- harmony ----------
FM, DB, BBM, CM = (53, 60, 65, 68, 72), (49, 56, 61, 65, 68), (46, 53, 58, 61, 65), (48, 55, 60, 64, 67)
LOW = {FM: (41, 48, 56, 60), DB: (37, 49, 53, 56), BBM: (34, 46, 53, 58), CM: (36, 48, 52, 55)}
SUB = {FM: 29, DB: 37, BBM: 34, CM: 36}  # the 808's notes: F1, Db2, Bb1, C2
ARP = {FM: 41, DB: 37, BBM: 34, CM: 36}
# the hook, sixteenth by sixteenth: (step, note)
COW = {
    FM: [(0, 77), (2, 77), (3, 80), (5, 77), (6, 75), (8, 72), (10, 75), (12, 77)],
    DB: [(0, 73), (2, 73), (3, 77), (5, 73), (6, 72), (8, 68), (10, 72), (12, 73), (14, 72)],
    BBM: [(0, 70), (2, 70), (3, 73), (5, 70), (6, 68), (8, 65), (10, 68), (12, 70)],
    CM: [(0, 72), (2, 72), (3, 76), (5, 72), (6, 70), (8, 67), (10, 70), (12, 72), (13, 73), (14, 76)],
}

drums, music, bass, cow, fx, amb, send = Bus(), Bus(), Bus(), Bus(), Bus(), Bus(), Bus()
kicks = []


def kick_at(t, gain=0.9):
    drums.add(kick(), t, gain)
    kicks.append(t)


def hearts(beats, gain):
    for b in beats:
        drums.add(heartbeat(), at(b), gain)
        drums.add(heartbeat(), at(b) + 0.19, gain * 0.6)


B = BARS
t_streets, t_boss, t_drop, t_out = bar_t(B["streets"]), bar_t(B["boss"]), bar_t(B["drop"]), bar_t(B["outro"])

# ---------- the city: rain, a heartbeat, a dark pad ----------
amb.add(rain_bed(t_streets + 0.4), 0, 0.10)
music.add(sweep(pad(LOW[FM], bar_t(B["oracle"]) + 0.4, cutoff=1400), 500, 1100, "lowpass"), 0, 0.24)
n = ns(t_streets)
bass.add(sine(hz(29), n) * np.minimum(1, np.arange(n) / ns(2.0)) * gate(n, 0.01, 0.6), 0, 0.08)
hearts([b for b in TL["hearts"] if b < B["oracle"] * 4], 0.7)
for line in TL["lines"]:
    for i, ch in enumerate(line["text"]):
        if ch != " ":
            fx.add(tick(), at(line["at"]) + i * TL["typeRate"], 0.2, pan=rng.uniform(-0.3, 0.3))
    fx.add(glitch(0.12), at(line["out"]), 0.32, pan=0.2)
for b in TL["glitches"]:
    fx.add(glitch(0.08), at(b), 0.4, pan=-0.3)

# ---------- the oracle wakes ----------
t_or = bar_t(B["oracle"])
fx.add(neon_buzz(1.6), t_or, 0.3)
arp = Bus()
for i, ch in enumerate((FM, CM)):
    for s in range(16):
        r = ARP[ch]
        arp.add(bass_note(r + (12 if s % 4 == 2 else 0), 0.09, drive=2.0, cutoff=900), bar_t(B["oracle"] + i, s / 4), 0.5)
    music.add(pad(LOW[ch], 4 * BEAT + 0.3, cutoff=900), bar_t(B["oracle"] + i), 0.16)
a0, a1 = ns(t_or), ns(t_streets)
arp.x[a0:a1] = sweep(arp.x[a0:a1], 350, 1600, "lowpass", shape=1.2)
bass.x += arp.x * 0.55
for k in range(36):
    tb = t_or + rng.uniform(0, 2 * 4 * BEAT - 0.3)
    fx.add(blip(int(rng.choice([77, 80, 82, 84, 87, 89, 92])), 0.04), tb, 0.06, pan=rng.uniform(-0.8, 0.8))
n = ns(2 * 4 * BEAT)
shim = sum(sine(hz(m), n, rng.random()) for m in (89, 92, 96)) / 3 * np.minimum(1, np.arange(n) / ns(1.0)) * 0.4
fx.add(shim * gate(n, 0.5, 0.3), t_or, 0.05)
t_now = at(TL["untilNow"])
fx.add(impact(1.6), t_now, 0.6)
bass.add(boom(1.8, 70, 32), t_now, 0.6)
fx.add(crash(2.0), t_now, 0.3)
fx.add(glitch(0.14), t_now, 0.3)
send.add(impact(1.0), t_now, 0.3)
fx.add(reverse_swell(1.2), t_streets - 1.2, 0.5)
fx.add(whoosh(0.9), t_streets - 0.9, 0.3)

# ---------- the streets: darksynth, a galloping bass, gated snares ----------
STREETS = (FM, DB, BBM, CM)
for b in range(B["streets"] * 4, B["boss"] * 4):
    kick_at(at(b), 0.7)
    if b % 2 == 1:
        drums.add(GATED, at(b), 0.45)
    for s in range(4):
        drums.add(hat(), at(b + s / 4), 0.07 if s % 2 == 0 else 0.11, pan=0.25)
    drums.add(hat(True), at(b + 0.5), 0.09, pan=-0.2)
arp = Bus()
for i, ch in enumerate(STREETS):
    b = B["streets"] + i
    for s in range(16):
        arp.add(bass_note(ARP[ch] + (12 if s % 4 == 2 else 0), 0.095, drive=2.4, cutoff=1400), bar_t(b, s / 4), 0.5)
    music.add(stab(ch, 0.5, attack=0.012), bar_t(b), 0.55)
    send.add(stab(ch, 0.5, attack=0.012), bar_t(b), 0.3)
    music.add(pad(ch, 4 * BEAT + 0.3, cutoff=1800), bar_t(b), 0.12)
    fx.add(crash(2.0), bar_t(b), 0.22)
    fx.add(zap(), bar_t(b), 0.3)
    if i >= 2:
        lead = Bus()
        for s in range(16):
            lead.add(pluck(ch[(0, 2, 4, 2)[s % 4]] + 12, 0.12), bar_t(b, s / 4), 0.5, pan=0.4 if s % 2 else -0.4)
        music.x += lead.x * 0.32
        send.x += lead.x * 0.2
a0, a1 = ns(t_streets), ns(t_boss)
arp.x[a0:a1] = sweep(arp.x[a0:a1], 800, 3200, "lowpass", shape=1.2)
bass.x += arp.x * 0.5
for i, A in enumerate(TL["archetypes"]):
    t0 = bar_t(B["streets"] + i)
    for k in range(len(A["brag"].split(" "))):
        fx.add(blip(84 + (k % 3) * 3, 0.03), t0 + 0.08 + k * BEAT / 2, 0.05, pan=0.3)
fx.add(reverse_swell(0.8), t_boss - 0.8, 0.45)

# ---------- the boss: the lights go out, the cigar glows ----------
P = TL["boss"]
t_puff, t_hush = at(P["puff"]), at(P["hush"])
amb.add(rain_bed(t_drop - t_boss), t_boss, 0.09)
fx.add(neon_buzz(1.8), t_boss, 0.32)
bass.add(b808(29, 2.4, glide=0), t_boss, 0.55)
fx.add(impact(1.2), t_boss, 0.35)
hearts([b for b in TL["hearts"] if B["boss"] * 4 <= b < B["drop"] * 4], 0.85)
for i, ch in enumerate((DB, CM)):
    length = 4 * BEAT if i == 0 else t_puff - bar_t(B["boss"] + 1)
    music.add(cut(pad(LOW[ch], length + 0.4, cutoff=700, voices=5), length), bar_t(B["boss"] + i), 0.16)
# the hook, heard through a wall
tease = Bus()
for s, m in COW[FM]:
    tease.add(cowbell(m), bar_t(B["boss"] + 1, s / 4), 0.5)
cow.x += lp(tease.x, 900) * 0.5
r0, r1 = P["roll"]
roll = [at(b) for b in np.arange(r0, r0 + 1, 0.25)] + [at(b) for b in np.arange(r0 + 1, r1, 0.125)]
for t in roll:
    p = (t - at(r0)) / (at(r1) - at(r0))
    drums.add(snare(180 + 140 * p), t, 0.2 + 0.5 * p ** 1.3)
    send.add(snare(180 + 140 * p), t, 0.1 + 0.18 * p)
t_r = at(P["line"])
n = ns(t_puff - t_r)
fx.add(hp(sweep(noise(n), 300, 12000, "lowpass", shape=1.6) * np.linspace(0, 1, n) ** 2.2, 250), t_r, 0.34)
f = hz(53) * 2 ** (np.linspace(0, 1, n) ** 1.3 * 2)
fx.add(sweep(saw(f, n) + 0.6 * saw(f * 1.5, n), 600, 8000, "lowpass") * np.linspace(0, 1, n) ** 1.8, t_r, 0.13)
for text, beat in (("relax.", P["relax"]), (P["text"], P["line"])):
    for i, ch in enumerate(text):
        if ch != " ":
            fx.add(tick(), at(beat) + i * P["rate"], 0.22, pan=rng.uniform(-0.2, 0.2))
# the puff: the ember crackles, a breath, then nothing
fx.add(crackle(0.3), t_puff - 0.05, 0.5)
fx.add(breath(0.32), t_puff, 0.35)
drums.add(kick(drive=2.6), t_puff, 0.8)
fx.add(reverse_swell(t_drop - t_hush + 0.08), t_hush - 0.08, 0.55)

# ---------- the drop: phonk ----------
DROP = (FM, DB, BBM, CM, DB, CM)
fx.add(crash(3.2), t_drop, 0.6)
fx.add(impact(1.8), t_drop, 0.7)
bass.add(boom(2.6, 80, 30), t_drop, 0.6)
fx.add(neon_buzz(1.4), t_drop, 0.3)
send.add(impact(1.2), t_drop, 0.45)
KS, CS = TL["drop"]["kick"], TL["drop"]["clap"]
for i, ch in enumerate(DROP):
    b = B["drop"] + i
    for k, s in enumerate(KS):
        kick_at(bar_t(b, s / 4), 0.85)
        nxt = KS[k + 1] if k + 1 < len(KS) else 16
        glide = 12 if (s == KS[-1] and i % 2 == 1) else 0
        bass.add(b808(SUB[ch], (nxt - s) * BEAT / 4, glide=glide), bar_t(b, s / 4), 0.62)
    for s in CS:
        drums.add(clap(), bar_t(b, s / 4), 0.55)
        send.add(clap(), bar_t(b, s / 4), 0.35)
    for s in range(16):
        v = (0.10, 0.05, 0.13, 0.05)[s % 4]
        drums.add(hat(), bar_t(b, s / 4), v, pan=0.3)
        if s >= 14:
            drums.add(hat(), bar_t(b, s / 4 + 1 / 8), v * 0.8, pan=0.3)
    for s, m in COW[ch]:
        cow.add(cowbell(m), bar_t(b, s / 4), 0.5)
        if i >= 4:
            music.add(pluck(m - 12, 0.18, cutoff=3200), bar_t(b, s / 4), 0.28)
    music.add(pad(ch, 4 * BEAT + 0.3, cutoff=2400, voices=5), bar_t(b), 0.14)
    if i in (0, 2, 4):
        music.add(stab(ch, 0.6, attack=0.003), bar_t(b), 0.5)
        send.add(stab(ch, 0.6, attack=0.003), bar_t(b), 0.3)
        fx.add(crash(2.2), bar_t(b), 0.3)
t_hero = bar_t(B["hero"])
fx.add(crash(2.0), t_hero, 0.35)
fx.add(impact(0.9), t_hero, 0.45)
for k in range(8):
    fx.add(pop(), bar_t(B["pump"], k), 0.25, pan=rng.uniform(-0.4, 0.4))
    send.add(pop(), bar_t(B["pump"], k), 0.12)
R = TL["roster"]
for i in range(9):
    fx.add(blip(72 + i * 2, 0.05), at(R["fill"] + i / 4), 0.12, pan=(i % 3 - 1) * 0.4)
spin = [at(R["spin"]) + (at(R["lock"]) - at(R["spin"])) * (j / R["jumps"]) ** R["curve"] for j in range(R["jumps"])]
for t in spin:
    fx.add(blip(91, 0.03), t, 0.14)
fx.add(impact(1.0), at(R["lock"]), 0.6)
bass.add(boom(1.4, 85, 35), at(R["lock"]), 0.45)
fx.add(zap(), at(R["lock"]), 0.4)
fx.add(crash(2.0), at(R["lock"]), 0.3)
s0 = at(R["strobe"])
for t in list(np.arange(s0, s0 + BEAT, BEAT / 4)) + list(np.arange(s0 + BEAT, t_out, BEAT / 8)):
    p = (t - s0) / (t_out - s0)
    drums.add(snare(200 + 160 * p), t, 0.28 + 0.4 * p)
fx.add(whoosh(t_out - s0), s0, 0.4)

# ---------- outro: the last hit rings out under the signs ----------
kick_at(t_out, 1.0)
fx.add(crash(4.0), t_out, 0.6)
fx.add(impact(2.4), t_out, 0.7)
bass.add(boom(3.2, 82, 28), t_out, 0.75)
fx.add(neon_buzz(1.6), t_out, 0.25)
big = sweep(supersaw(FM + (77,), ns(2.6)) * ad(ns(2.6), 0.003, 0.9)[:, None], 9000, 900, "lowpass", shape=0.5)
music.add(big, t_out, 0.7)
send.add(big, t_out, 0.45)
echo = Bus()
for s, m in COW[FM][:6]:
    echo.add(cowbell(m), t_out + s * BEAT / 4, 0.5)
cow.x += lp(pingpong(echo.x, 3 * BEAT / 4, 0.5, 6), 2400) * 0.45
music.add(sweep(pad(LOW[FM], DUR - t_out, cutoff=3000), 2400, 260, "lowpass"), t_out, 0.22)
amb.add(rain_bed(DUR - t_out), t_out, 0.1)
O = TL["outro"]
fx.add(neon_buzz(1.2), at(O["soon"]), 0.22)
fx.add(glitch(0.1), at(O["soon"]), 0.25)
fx.add(tick(), at(O["footer"]), 0.3)
hearts([b for b in TL["hearts"] if b >= B["outro"] * 4], 0.6)

# ---------- mix ----------
def duck_curve(depth):
    d = np.ones(N)
    for t in kicks:
        i = ns(t)
        k = np.arange(min(N - i, ns(0.5))) / SR
        env = 1 - depth * np.minimum(1, k / 0.004) * np.exp(-k / 0.11)
        d[i : i + len(env)] = np.minimum(d[i : i + len(env)], env)
    return d[:, None]


hard, soft = duck_curve(0.72), duck_curve(0.3)
cow.x = cow.x + pingpong(cow.x, 3 * BEAT / 4, 0.32, 4) * 0.35
send.x += cow.x * 0.15
verb = signal.fftconvolve(send.x, reverb_ir(), axes=0)[:N] * 0.28
mix = drums.x + (music.x + bass.x) * hard + cow.x * soft * 0.9 + verb + amb.x
# the beat of nothing before the drop: only the swell and the last crackle survive it
q0, q1 = ns(t_hush), ns(t_drop)
hush = np.ones(N)
hush[q0 - ns(0.04) : q0] = np.linspace(1, 0, ns(0.04))
hush[q0:q1] = 0
mix = mix * hush[:, None] + fx.x
mix = hp(mix, 26, 2)


def _db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)


print("  bus      streets   drop   (rms dB before the master)")
for name, bus in (("drums", drums.x), ("music", music.x * hard), ("bass", bass.x * hard), ("cow", cow.x * soft), ("fx", fx.x), ("verb", verb)):
    print(f"  {name:6s} {_db(bus[ns(t_streets) : ns(t_boss)]):8.1f} {_db(bus[ns(t_drop) : ns(t_out)]):6.1f}")
mix = mix[: ns(DUR)]
mix /= np.max(np.abs(mix)) + 1e-9
drive = 1.9
mix = np.tanh(mix * drive) / np.tanh(drive)
fade = ns(0.6)
mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 2
mix *= 0.84 / (np.max(np.abs(mix)) + 1e-9)

out = sys.argv[1] if len(sys.argv) > 1 else str(HERE / "score.wav")
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((np.clip(mix, -1, 1) * 32767).astype("<i2").tobytes())
print("score:", out, f"{DUR:.1f}s")
