"""Upscale an image 4x with Real-ESRGAN's compact general model, in plain numpy.

    python3 upscale.py in.png out.webp --weights realesr-general-x4v3.pth [--scale 2]

The weights (4.9 MB, BSD-3-Clause) are at
https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth
No torch needed: the checkpoint is read straight out of its zip, and the network
(SRVGGNetCompact: 34 3x3 convs with PReLU, then a pixel shuffle) is a few matmuls.
--scale 2 renders at 4x and resamples to 2x, which is sharper than a 2x model.
"""
import argparse
import collections
import pickle
import zipfile

import numpy as np
from PIL import Image

DTYPES = {"FloatStorage": np.float32, "HalfStorage": np.float16, "DoubleStorage": np.float64}


def load_pth(path):
    zf = zipfile.ZipFile(path)
    pkl = next(n for n in zf.namelist() if n.endswith("data.pkl"))
    root = pkl[: -len("data.pkl")]
    cache = {}

    def rebuild(storage, offset, size, stride, *_):
        it = storage.itemsize
        return np.lib.stride_tricks.as_strided(storage[offset:], tuple(size), tuple(s * it for s in stride)).copy()

    class Unpickler(pickle.Unpickler):
        def find_class(self, mod, name):
            if (mod, name) == ("torch._utils", "_rebuild_tensor_v2"):
                return rebuild
            if (mod, name) == ("collections", "OrderedDict"):
                return collections.OrderedDict
            if mod == "torch" and name in DTYPES:
                return DTYPES[name]
            raise pickle.UnpicklingError(f"unexpected {mod}.{name}")

        def persistent_load(self, pid):
            _, dtype, key, _, _ = pid
            if key not in cache:
                cache[key] = np.frombuffer(zf.read(f"{root}data/{key}"), dtype=dtype)
            return cache[key]

    return Unpickler(zf.open(pkl)).load()


def conv3x3(x, w, b):
    c, h, wd = x.shape
    xp = np.pad(x, ((0, 0), (1, 1), (1, 1)))
    cols = np.empty((c, 9, h, wd), np.float32)
    for k in range(9):
        dy, dx = divmod(k, 3)
        cols[:, k] = xp[:, dy : dy + h, dx : dx + wd]
    out = w.reshape(w.shape[0], -1) @ cols.reshape(c * 9, h * wd)
    out += b[:, None]
    return out.reshape(-1, h, wd)


def run(x, layers, scale=4):
    out = x
    for kind, p in layers:
        if kind == "conv":
            out = conv3x3(out, *p)
        else:
            out = np.where(out > 0, out, out * p[:, None, None])
    c, h, w = out.shape
    out = out.reshape(c // scale ** 2, scale, scale, h, w).transpose(0, 3, 1, 4, 2).reshape(c // scale ** 2, h * scale, w * scale)
    return out + x.repeat(scale, axis=1).repeat(scale, axis=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--weights", required=True)
    ap.add_argument("--scale", type=int, default=4)
    ap.add_argument("--tile", type=int, default=288)
    a = ap.parse_args()

    sd = load_pth(a.weights)
    sd = sd.get("params_ema") or sd.get("params") or sd
    idx = sorted({int(k.split(".")[1]) for k in sd if k.startswith("body.")})
    layers = []
    for i in idx:
        if f"body.{i}.bias" in sd:
            layers.append(("conv", (sd[f"body.{i}.weight"].astype(np.float32), sd[f"body.{i}.bias"].astype(np.float32))))
        else:
            layers.append(("prelu", sd[f"body.{i}.weight"].astype(np.float32)))
    pad = sum(k == "conv" for k, _ in layers) + 2  # the receptive field, so tiles join without seams

    img = np.asarray(Image.open(a.src).convert("RGB"), np.float32).transpose(2, 0, 1) / 255
    _, h, w = img.shape
    out = np.zeros((3, h * 4, w * 4), np.float32)
    tiles = [(y, x) for y in range(0, h, a.tile) for x in range(0, w, a.tile)]
    for n, (y, x) in enumerate(tiles):
        y1, x1 = min(h, y + a.tile), min(w, x + a.tile)
        py, px = max(0, y - pad), max(0, x - pad)
        sub = run(img[:, py : min(h, y1 + pad), px : min(w, x1 + pad)], layers)
        out[:, y * 4 : y1 * 4, x * 4 : x1 * 4] = sub[:, (y - py) * 4 : (y1 - py) * 4, (x - px) * 4 : (x1 - px) * 4]
        print(f"\rtile {n + 1}/{len(tiles)}", end="", flush=True)
    print()
    res = Image.fromarray((np.clip(out, 0, 1).transpose(1, 2, 0) * 255 + 0.5).astype(np.uint8))
    if a.scale != 4:
        res = res.resize((w * a.scale, h * a.scale), Image.LANCZOS)
    res.save(a.dst, quality=92, method=6) if a.dst.endswith(".webp") else res.save(a.dst)
    print(a.dst, res.size)


if __name__ == "__main__":
    main()
