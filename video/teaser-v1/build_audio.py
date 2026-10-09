"""Synthesized score for the teaser. Beat grid matches T in teaser.html.

    python3 build_audio.py out.wav 20
"""
import sys
import wave

import numpy as np

SR = 48000
out_path = sys.argv[1]
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
N = int(SR * DUR)
L = np.zeros(N)
R = np.zeros(N)
rng = np.random.default_rng(7)


def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    L[i : i + len(sig)] += sig * (1 - max(0, pan))
    R[i : i + len(sig)] += sig * (1 + min(0, pan))


def env(n, attack, decay):
    t = np.arange(n) / SR
    return np.minimum(1, t / max(attack, 1e-4)) * np.exp(-t / decay)


def lowpass(x, a):
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc += a * (v - acc)
        y[i] = acc
    return y


def kick(len_s=0.9, f0=140, f1=38, decay=0.32):
    n = int(SR * len_s)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.tanh(2.2 * np.sin(ph) * env(n, 0.001, decay))


def noise_hit(len_s=0.35, decay=0.07, a=0.25):
    n = int(SR * len_s)
    return lowpass(rng.standard_normal(n), a) * env(n, 0.0005, decay)


def tick():
    n = int(SR * 0.04)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * 2400 * t) * 0.5 + rng.standard_normal(n) * 0.5) * env(n, 0.0002, 0.006)


# typing "!call" (5 keys between 1.0 and 1.8)
for k in range(6):  # "!oddie", one key per character, as teaser.html types it
    add(tick(), 1.0 + k * 0.8 / 6, 0.35, pan=(k - 2.5) * 0.12)

# the hits, one per cut
hits = [2.0, 2.2, 2.8, 3.4, 4.0, 4.6, 7.4, 8.2, 9.0, 16.6]
for i, h in enumerate(hits):
    add(kick(), h, 0.85)
    add(noise_hit(), h, 0.45, pan=0.3 if i % 2 else -0.3)

# a pulse under the card and the slams: 8th notes at 150bpm
step = 60 / 150 / 2
t = 4.6
while t < 9.8:
    n = int(SR * 0.12)
    tt = np.arange(n) / SR
    add(np.sin(2 * np.pi * 55 * tt) * env(n, 0.003, 0.05), t, 0.35)
    add(noise_hit(0.05, 0.01, 0.9), t + step / 2, 0.08, pan=0.5)
    t += step

# drone through the card
n = int(SR * 2.8)
tt = np.arange(n) / SR
drone = (np.sin(2 * np.pi * 41.2 * tt) + 0.4 * np.sin(2 * np.pi * 82.4 * tt + np.sin(tt * 3))) * np.minimum(1, tt / 0.3) * np.minimum(1, (2.8 - tt) / 0.4)
add(drone, 4.6, 0.25)

# the riser: 9.8 -> 13.0, noise sweep + rising saw-ish tone + snare roll
n = int(SR * 3.2)
tt = np.arange(n) / SR
p = tt / 3.2
nz = rng.standard_normal(n)
# brighten the noise as it rises: blend from heavily filtered to raw
dark = lowpass(nz, 0.03)
riser = (dark * (1 - p) + nz * p * 0.6) * p**2
f = 110 * 2 ** (p * 3)
ph = 2 * np.pi * np.cumsum(f) / SR
tone = (np.sin(ph) + 0.5 * np.sin(2 * ph) + 0.25 * np.sin(3 * ph)) * p**1.6 * 0.5
sub = np.sin(2 * np.pi * 36 * tt) * 0.5 * (0.4 + 0.6 * p)
add(riser, 9.8, 0.55)
add(tone, 9.8, 0.35)
add(sub, 9.8, 0.4)
roll_t = 11.0
while roll_t < 12.95:
    q = (roll_t - 11.0) / 2.0
    add(noise_hit(0.08, 0.02, 0.5), roll_t, 0.12 + 0.3 * q, pan=0.2)
    roll_t += 0.25 * (1 - q) + 0.04
# a breath of silence right before the drop
gap = slice(int(12.92 * SR), int(13.0 * SR))
L[gap] *= np.linspace(1, 0, gap.stop - gap.start)
R[gap] *= np.linspace(1, 0, gap.stop - gap.start)

# THE DROP at 13.0: long sub boom + impact + shimmer tail
add(kick(3.2, 90, 30, 1.4), 13.0, 1.0)
add(noise_hit(1.5, 0.35, 0.12), 13.0, 0.6)
n = int(SR * 3.4)
tt = np.arange(n) / SR
pad = sum(np.sin(2 * np.pi * fr * tt + i) for i, fr in enumerate([55, 82.4, 110, 164.8, 220])) / 5
add(pad * np.minimum(1, tt / 0.05) * np.exp(-tt / 1.6), 13.0, 0.35)
shimmer = sum(np.sin(2 * np.pi * fr * tt) for fr in [880, 1318.5, 1760]) / 3
add(shimmer * env(n, 0.3, 1.0) * 0.5, 13.2, 0.12)

# the tail under COMING SOON
n = int(SR * 3.4)
tt = np.arange(n) / SR
tail = sum(np.sin(2 * np.pi * fr * tt) for fr in [41.2, 61.7, 82.4]) / 3
add(tail * env(n, 0.02, 1.4), 16.6, 0.5)
add(noise_hit(2.0, 0.6, 0.05), 16.6, 0.25)

# master: gentle saturation, normalize, fade out
mix = np.stack([L, R], axis=1)
mix = np.tanh(mix * 1.1)
mix /= np.max(np.abs(mix)) + 1e-9
mix *= 0.89
fade = int(0.5 * SR)
mix[-fade:] *= np.linspace(1, 0, fade)[:, None]

with wave.open(out_path, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())
print("score:", out_path)
