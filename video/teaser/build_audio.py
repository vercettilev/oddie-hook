"""The teaser's score: 150 BPM in F minor, synthesized from nothing (no samples, nothing to license).

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


# ---------- instruments ----------
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
    n = ns(0.32 if open_ else 0.055)
    return hp(noise(n), 7200, 4) * ad(n, 0.0004, 0.10 if open_ else 0.016)


def crash(length=2.8):
    n = ns(length)
    t = np.arange(n) / SR
    ring = sum(np.sin(2 * np.pi * f * t + rng.random() * 6) for f in (3170, 4425, 5310, 6880, 8120)) * 0.06
    return hp(noise(n) + ring, 3800, 2) * ad(n, 0.0015, length * 0.33)


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


def blip(m):
    n = ns(0.05)
    return (np.sign(sine(hz(m), n)) * 0.5 + sine(hz(m) * 2, n) * 0.5) * ad(n, 0.0004, 0.012)


def tick():
    n = ns(0.025)
    return bp(noise(n), 2200, 7500) * ad(n, 0.0002, 0.0035) + sine(1500 + rng.random() * 600, n) * ad(n, 0.0002, 0.0025) * 0.4


def glitch(length=0.11):
    """A bit-crushed burst: stepped square tones over held noise."""
    n = ns(length)
    step = ns(0.007)
    f = np.repeat(rng.choice([140, 280, 560, 1120, 2240, 4480], size=n // step + 1), step)[:n]
    sq = np.sign(sine(f, n))
    held = np.repeat(noise(n // 24 + 1), 24)[:n]
    return np.tanh(1.5 * (0.6 * sq + 0.5 * held)) * gate(n, 0.002, 0.02)


def cut(sig, at_sec, fade=0.02):
    sig = np.array(sig, float)
    i, f = ns(at_sec), ns(fade)
    sig[i:] = 0
    sig[max(0, i - f) : i] *= np.linspace(1, 0, i - max(0, i - f)).reshape((-1,) + (1,) * (sig.ndim - 1))
    return sig


def reverse_swell(length):
    c = crash(length + 0.6)[: ns(length)][::-1]
    return c * np.linspace(0, 1, len(c)) ** 1.5


def whoosh(length):
    n = ns(length)
    x = sweep(noise(n), 400, 9000, "lowpass", shape=1.4)
    return x * np.linspace(0, 1, n) ** 2


def stab(chord, length=0.15):
    n = ns(length + 0.25)
    x = supersaw(chord, n) * ad(n, 0.002, length * 0.9)[:, None]
    return sweep(x, 9500, 1600, "lowpass", shape=0.6)


def pad(chord, length, cutoff=1800, voices=5):
    n = ns(length)
    x = supersaw(chord, n, voices=voices, cents=14) * gate(n, 0.25, 0.4)[:, None]
    return lp(x, cutoff)


def pluck(m, length=0.14):
    n = ns(length)
    x = (saw(hz(m), n) + saw(hz(m) * 1.004, n)) * 0.5
    return lp(x, 4200) * ad(n, 0.002, 0.07)


def bass_note(m, length, drive=2.6, cutoff=1100):
    n = ns(length)
    mid = (saw(hz(m + 12), n) + saw(hz(m + 12) * 1.008, n) + saw(hz(m + 12) * 0.992, n)) / 3
    mid = lp(np.tanh(drive * mid), cutoff)
    sub = sine(hz(m), n)
    return (0.55 * mid + 0.8 * sub) * gate(n, 0.004, 0.03)


def reverb_ir(seconds=2.3, damp=5500):
    n = ns(seconds)
    t = np.arange(n) / SR
    ir = np.stack([noise(n), noise(n)], axis=1) * np.exp(-t / (seconds / 6.5))[:, None]
    ir = lp(ir, damp)
    ir[: ns(0.015)] = 0
    return ir / np.sqrt(np.sum(ir ** 2) / 2)


# ---------- harmony ----------
FM, DB, AB, EB = (53, 60, 65, 68, 72), (49, 56, 61, 65, 68), (56, 60, 63, 68, 72), (51, 58, 63, 67, 70)
ROOT = {FM: 29, DB: 25, AB: 32, EB: 27}  # F1, Db1, Ab1, Eb1 for the sub
LOW = {FM: (41, 48, 56, 60), DB: (37, 49, 53, 56), AB: (44, 51, 56, 60), EB: (39, 51, 55, 58)}

drums, music, bass, fx, send = Bus(), Bus(), Bus(), Bus(), Bus()
kicks = []


def bar_t(bar, beat=0.0):
    return at(bar * 4 + beat)


def kick_at(t, gain=0.95):
    drums.add(kick(), t, gain)
    kicks.append(t)


# ---------- intro: a heartbeat in the dark ----------
intro, build, rise, drop, outro = BARS["intro"], BARS["build"], BARS["rise"], BARS["drop"], BARS["outro"]
for i, ch in enumerate((FM, FM, DB, EB)):
    b = intro + i
    music.add(pad(LOW[ch], 4 * BEAT + 0.4, cutoff=420 + i * 120, voices=5), bar_t(b), 0.20 + 0.05 * i)
    for k, (dt, g) in enumerate(((0, 0.9), (0.19, 0.55))):
        drums.add(heartbeat(), bar_t(b) + dt, g * (0.65 + 0.12 * i))
n = ns(at(build * 4))
drone = sine(hz(29), n) * np.minimum(1, np.arange(n) / ns(2.5)) * (0.85 + 0.15 * np.sin(np.arange(n) / SR * 2 * np.pi * 0.5))
bass.add(drone, 0, 0.16)

for line in TL["lines"][:-1]:
    t0 = at(line["at"])
    for i, ch in enumerate(line["text"]):
        if ch != " ":
            fx.add(tick(), t0 + i * TL["typeRate"], 0.22, pan=rng.uniform(-0.3, 0.3))
    fx.add(glitch(0.12), at(line["out"]), 0.35, pan=0.2)
for b in TL["subliminal"]:
    fx.add(glitch(0.08), at(b), 0.42, pan=-0.3)
t_now = at(TL["lines"][-1]["at"])
fx.add(impact(1.6), t_now, 0.55)
bass.add(boom(1.8, 70, 32), t_now, 0.55)
send.add(impact(1.0), t_now, 0.3)
fx.add(reverse_swell(1.2), at(build * 4) - 1.2, 0.5)
fx.add(whoosh(0.9), at(build * 4) - 0.9, 0.3)

# ---------- build: every platform, a chat, a market ----------
for b in range(build * 4, rise * 4):
    kick_at(at(b), 0.78)
for i, b in enumerate(TL["logoSlams"]):
    fx.add(zap(), at(b), 0.35, pan=(-0.4, 0.4, -0.2, 0.2)[i])
    fx.add(impact(0.6), at(b), 0.35)
    send.add(zap(), at(b), 0.2)
prog = (FM, DB, AB, EB)
for i in range(4):
    ch, b = prog[i], build + i
    for beat in range(4):
        bass.add(bass_note(ROOT[ch], 0.17, drive=2.0, cutoff=700 + 250 * i), bar_t(b, beat + 0.5), 0.40)
    music.add(pad(ch, 4 * BEAT + 0.3, cutoff=1500), bar_t(b), 0.15)
# the arp opens up across the four bars
arp = Bus()
for i in range(4):
    ch = prog[i]
    order = (0, 1, 2, 3, 4, 3, 2, 1)
    for s in range(16):
        arp.add(pluck(ch[order[s % 8]] + 12), bar_t(build + i, s / 4), 0.5, pan=0.35 if s % 2 else -0.35)
a0, a1 = ns(bar_t(build)), ns(bar_t(rise))
arp.x[a0:a1] = sweep(arp.x[a0:a1], 500, 7500, "lowpass", shape=1.3)
music.x += arp.x * 0.8
send.x += arp.x * 0.20
for b in range(build * 4 + 4, rise * 4):
    for s in range(4):
        drums.add(hat(), at(b + s / 4), 0.10 if s % 2 == 0 else 0.16, pan=0.25)
for b in range(build * 4 + 8, rise * 4):
    drums.add(hat(True), at(b + 0.5), 0.14, pan=-0.2)
    if b % 2 == 1:
        drums.add(clap(), at(b), 0.42)
        send.add(clap(), at(b), 0.30)
tp = at(TL["chatPull"])
fx.add(whoosh(at(TL["card"]) - tp), tp, 0.32)
fx.add(impact(0.9), at(TL["card"]), 0.5)
# odds ticking up as people take sides: one blip per point, 50% -> 73%
t_card = at(TL["card"])
for k in range(1, 24):
    x = 1 - (1 - k / 23) ** (1 / 3)
    fx.add(blip(72 + k), t_card + 0.3 + 0.95 * x, 0.10, pan=0.3)
for i, b in enumerate(TL["words"]):
    fx.add(impact(0.7), at(b), 0.45)
    bass.add(boom(0.5, 90, 45), at(b), 0.25)
    send.add(clap(), at(b), 0.25)

# ---------- rise: the roll, the climb, then nothing ----------
r = rise * 4
roll = [at(b) for b in np.arange(r, r + 4, 0.5)] + [at(b) for b in np.arange(r + 4, r + 6, 0.25)] + [at(b) for b in np.arange(r + 6, r + 7, 0.125)]
t_r0, t_call = at(r), at(TL["riseWords"][3])
for t in roll:
    p = (t - t_r0) / (t_call - t_r0)
    drums.add(snare(180 + 140 * p), t, 0.22 + 0.55 * p ** 1.3)
    send.add(snare(180 + 140 * p), t, 0.12 + 0.2 * p)
kick_at(t_r0)
fx.add(crash(2.0), t_r0, 0.25)
n = ns(t_call - t_r0)
nz = sweep(noise(n), 300, 12000, "lowpass", shape=1.6) * np.linspace(0, 1, n) ** 2.2
fx.add(hp(nz, 250), t_r0, 0.5)
f = hz(53) * 2 ** (np.linspace(0, 1, n) ** 1.3 * 2)
tone = sweep(saw(f, n) + 0.6 * saw(f * 1.5, n), 600, 8000, "lowpass") * np.linspace(0, 1, n) ** 1.8
fx.add(tone, t_r0, 0.16)
for i, ch in enumerate((DB, EB)):
    length = 4 * BEAT if i == 0 else t_call - bar_t(rise + 1)
    p = sweep(pad(ch, length + 0.4, cutoff=4000, voices=7), 120 + 600 * i, 900 + 1700 * i, "highpass")
    music.add(cut(p, length), bar_t(rise + i), 0.16)
    bass.add(cut(bass_note(ROOT[ch], length + 0.1, drive=1.4, cutoff=500), length), bar_t(rise + i), 0.32 if i == 0 else 0.22)
for b in TL["riseWords"][:3]:
    bass.add(boom(0.6, 85, 40), at(b), 0.4)
    fx.add(impact(0.5), at(b), 0.35)
# "CALL": one dry slam, then a breath of silence, then the swell into the drop
drums.add(kick(drive=2.6), t_call, 1.0)
drums.add(clap(), t_call, 0.5)
fx.add(reverse_swell(at(drop * 4) - at(TL["blackout"]) + 0.12), at(TL["blackout"]) - 0.12, 0.55)

# ---------- the drop ----------
t_drop = at(drop * 4)
fx.add(crash(3.2), t_drop, 0.6)
fx.add(impact(1.8), t_drop, 0.7)
bass.add(boom(2.6, 80, 30), t_drop, 0.7)
send.add(impact(1.2), t_drop, 0.45)
drop_prog = (FM, DB, AB, EB, DB, EB)
STABS = {0: (0, 3, 6, 10, 12), 1: (0, 3, 6, 8, 10, 12, 14)}
for i, ch in enumerate(drop_prog):
    b = drop + i
    for beat in range(4):
        if not (i == 5 and beat == 3):
            kick_at(bar_t(b, beat), 0.88)
        if beat % 2 == 1:
            drums.add(clap(), bar_t(b, beat), 0.55)
            send.add(clap(), bar_t(b, beat), 0.35)
        for s in range(4):
            drums.add(hat(), bar_t(b, beat + s / 4), (0.07, 0.10, 0.16, 0.10)[s], pan=0.3)
        drums.add(hat(True), bar_t(b, beat + 0.5), 0.15, pan=-0.25)
    pattern = STABS[1] if i in (3, 5) else STABS[0]
    for k, s in enumerate(pattern):
        last = k == len(pattern) - 1
        st = stab(ch, 0.28 if last else 0.15)
        music.add(st, bar_t(b, s / 4), 1.25)
        send.add(st, bar_t(b, s / 4), 0.3)
    music.add(pad(ch, 4 * BEAT + 0.3, cutoff=2600, voices=5), bar_t(b), 0.2)
    bass.add(bass_note(ROOT[ch], 4 * BEAT - 0.02), bar_t(b), 0.5)
for b in (drop + 2, drop + 4):
    fx.add(crash(2.2), bar_t(b), 0.35)
t_swap = at(TL["paletteSwap"])
fx.add(crash(2.0), t_swap, 0.4)
fx.add(impact(0.9), t_swap, 0.45)
for b in TL["stickers"]:
    fx.add(pop(), at(b), 0.28, pan=rng.uniform(-0.4, 0.4))
    send.add(pop(), at(b), 0.15)
for b in TL["tiles"]:
    fx.add(zap(), at(b), 0.3)
for t in np.arange(at(TL["stickers"][-1]), at(TL["stickers"][-1] + 1), BEAT / 4):
    drums.add(snare(240), t, 0.35)
for b in TL["tagline"]:
    fx.add(impact(0.6), at(b), 0.45)
s0, s1 = TL["strobe"]
for t in list(np.arange(at(s0), at(s0 + 1), BEAT / 4)) + list(np.arange(at(s0 + 1), at(s1), BEAT / 8)):
    p = (t - at(s0)) / (at(s1) - at(s0))
    drums.add(snare(200 + 160 * p), t, 0.3 + 0.4 * p)
fx.add(whoosh(at(s1) - at(s0)), at(s0), 0.4)

# ---------- outro: the last hit rings out under COMING SOON ----------
t_out = at(outro * 4)
kick_at(t_out, 1.0)
fx.add(crash(4.0), t_out, 0.6)
fx.add(impact(2.4), t_out, 0.7)
bass.add(boom(3.2, 82, 28), t_out, 0.8)
big = supersaw(FM + (77,), ns(2.6)) * ad(ns(2.6), 0.003, 0.9)[:, None]
big = sweep(big, 9000, 900, "lowpass", shape=0.5)
music.add(big, t_out, 0.8)
send.add(big, t_out, 0.45)
tail = pad(LOW[FM], DUR - t_out, cutoff=3000, voices=5)
music.add(sweep(tail, 2400, 260, "lowpass"), t_out, 0.22)
O = TL["outro"]
fx.add(glitch(0.1), at(O["soon"]), 0.3)
fx.add(impact(0.8), at(O["soon"]), 0.3)
n = ns(0.9)
shimmer = sum(sine(hz(m), n) for m in (84, 88, 91, 96)) / 4 * ad(n, 0.05, 0.3)
fx.add(shimmer, at(O["shine"]), 0.14)
send.add(shimmer, at(O["shine"]), 0.2)
for b in (O["footer"], O["footer"] + 4):
    drums.add(heartbeat(), at(b), 0.55)
    drums.add(heartbeat(), at(b) + 0.19, 0.35)

# ---------- mix ----------
duck = np.ones(N)
for t in kicks:
    i = ns(t)
    k = np.arange(min(N - i, ns(0.5))) / SR
    env = 1 - 0.72 * np.minimum(1, k / 0.004) * np.exp(-k / 0.11)
    duck[i : i + len(env)] = np.minimum(duck[i : i + len(env)], env)
verb = signal.fftconvolve(send.x, reverb_ir(), axes=0)[:N]
mix = drums.x + (music.x + bass.x) * duck[:, None] + verb * 0.28
# the beat of nothing before the drop: only the reverse swell survives it
q0, q1 = ns(t_call + 0.16), ns(t_drop)
hush = np.ones(N)
hush[q0 - ns(0.05) : q0] = np.linspace(1, 0, ns(0.05))
hush[q0:q1] = 0
mix = mix * hush[:, None] + fx.x
mix = hp(mix, 26, 2)
def _db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)


print("  bus      build   drop   (rms dB before the master)")
for name, bus in (("drums", drums.x), ("music", music.x * duck[:, None]), ("bass", bass.x * duck[:, None]), ("fx", fx.x), ("verb", verb * 0.28)):
    sb, sd = bus[ns(at(build * 4)) : ns(at(rise * 4))], bus[ns(t_drop) : ns(t_out)]
    print(f"  {name:6s} {_db(sb):6.1f} {_db(sd):6.1f}")
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
