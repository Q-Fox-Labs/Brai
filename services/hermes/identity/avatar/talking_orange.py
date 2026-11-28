#!/usr/bin/env python3
# ABOUTME: Локально анимирует изображение апельсина по записи речи.
# ABOUTME: Использует только переданные аудио и изображение и локальный FFmpeg.
"""
Говорящий апельсин: липсинк фото апельсина под аудио с речью.

Работает полностью локально: numpy + opencv + локальный ffmpeg (без сети, без моделей).

    python talking_orange.py speech.wav -o out.mp4
    python talking_orange.py speech.mp3 -o out.mp4 --image orange.png --fps 30 --preview

Как это работает:
  * Рот на фото открыт. Находим тёмную полость рта (и нижнюю кромку зубов) автоматически.
  * Строим поле смещений: нижняя губа подтягивается вверх к зубам, верхняя чуть опускается.
    Это деформация (remap) исходных пикселей, поэтому текстура кожуры сохраняется.
    openness=1 -> рот как на фото, openness=0 -> рот закрыт.
  * Открытость рта на каждый кадр считается из громкости речевой полосы (250-3800 Гц)
    с шумовым гейтом, нормализацией по перцентилям и сглаживанием attack/release.
  * Сверху: моргание (кожа над глазом «съезжает» вниз как веко), лёгкое покачивание
    и сжатие/растяжение апельсина в такт речи.
"""
import argparse
import os
import shutil
import subprocess
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
for _s in (sys.stdout, sys.stderr):  # кириллица в консоли Windows
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# ----------------------------------------------------------------------------- audio
def find_ffmpeg(explicit=None):
    exe = explicit or shutil.which("ffmpeg")
    if not exe:
        sys.exit("ffmpeg не найден. Установите его (winget install Gyan.FFmpeg) или укажите --ffmpeg PATH")
    return exe


def load_audio(path, ffmpeg, sr=16000):
    """Декодирует любой аудиофайл в mono float32 через локальный ffmpeg."""
    cmd = [ffmpeg, "-v", "error", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, stdout=subprocess.PIPE, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32), sr


def mouth_curve(audio, sr, fps, lead_frames=1.0, attack=0.7, release=0.45, gamma=0.9):
    """Возвращает массив открытости рта [0..1] на каждый кадр видео."""
    n_frames = int(np.ceil(len(audio) / sr * fps))
    win = int(sr * 0.04)  # окно 40 мс
    window = np.hanning(win).astype(np.float32)
    freqs = np.fft.rfftfreq(win, 1.0 / sr)
    band = (freqs >= 250) & (freqs <= 3800)
    pad = np.pad(audio, (win, win))
    energy = np.zeros(n_frames, np.float32)
    for i in range(n_frames):
        t = (i + lead_frames) / fps  # рот чуть опережает звук — так воспринимается естественнее
        c = int(t * sr) + win
        seg = pad[max(0, c - win // 2): max(0, c - win // 2) + win]
        if len(seg) < win:
            seg = np.pad(seg, (0, win - len(seg)))
        spec = np.abs(np.fft.rfft(seg * window)) ** 2
        energy[i] = spec[band].sum()
    db = 10 * np.log10(energy + 1e-10)
    gate_db = max(np.percentile(db, 15) + 8.0, db.max() - 45)   # шумовой гейт
    amp = np.sqrt(energy)
    voiced = db > gate_db
    if not voiced.any():
        return np.zeros(n_frames, np.float32)
    ref = np.percentile(amp[voiced], 90)
    level = np.clip(amp / ref, 0, 1) ** 0.6
    # слоговая модуляция: громкость относительно локального максимума (~270 мс)
    k = max(3, int(fps * 0.27) | 1)
    padded = np.pad(amp, (k // 2, k // 2), mode="edge")
    local_max = np.lib.stride_tricks.sliding_window_view(padded, k).max(axis=1)
    mod = amp / (local_max + 1e-9)
    gate = np.clip((db - gate_db) / 6.0, 0, 1)  # мягкий гейт
    o = (level * (0.35 + 0.65 * mod) * gate) ** gamma
    # asymmetric smoothing: открывается быстро, закрывается чуть медленнее
    out = np.zeros_like(o)
    prev = 0.0
    for i, v in enumerate(o):
        k = attack if v > prev else release
        prev = prev + k * (v - prev)
        out[i] = prev
    return out


# ----------------------------------------------------------------------------- geometry
def detect_features(img):
    """Автоматически находит полость рта и глаза на фото апельсина."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    body = ((h < 30) & (s > 120)).astype(np.uint8)
    ys, xs = np.nonzero(body)
    bx0, bx1, by0, by1 = xs.min(), xs.max(), ys.min(), ys.max()
    bh = by1 - by0

    # рот: самая большая тёмная область в нижней половине тела
    dark = (v < 70).astype(np.uint8)
    dark[: by0 + int(bh * 0.45)] = 0
    dark[by0 + int(bh * 0.9):] = 0
    n, lab, st, _ = cv2.connectedComponentsWithStats(dark)
    if n < 2:
        sys.exit("Не удалось найти рот на изображении")
    mi = 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])
    mouth = (lab == mi).astype(np.uint8)
    mouth = cv2.morphologyEx(mouth, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))

    # глаза: светлые/ненасыщенные области (белки + радужка) в верхней части тела
    eyes_m = ((s < 110) | (v < 90)).astype(np.uint8)
    eyes_m[: by0 + int(bh * 0.15)] = 0
    eyes_m[by0 + int(bh * 0.45):] = 0
    # только внутри контура апельсина (выпуклая оболочка, ужатая от края)
    hull = np.zeros_like(body)
    pts = cv2.findNonZero(body)
    cv2.fillConvexPoly(hull, cv2.convexHull(pts), 1)
    hull = cv2.erode(hull, np.ones((41, 41), np.uint8))
    eyes_m &= hull
    eyes_m = cv2.morphologyEx(eyes_m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(eyes_m)
    cand = [tuple(st[i, :4]) for i in range(1, n) if st[i, 4] > 800]
    cand = sorted(cand, key=lambda r: -r[2] * r[3])[:2]
    return dict(body=(bx0, by0, bx1, by1), mouth=mouth, eyes=cand, hull=hull)


def build_mouth_field(mouth, body, upper_share=0.3, smooth=9):
    """Поле вертикальных смещений D(x,y) для полностью закрытого рта (c=1)."""
    H, W = mouth.shape
    by1 = body[3]
    top = np.zeros(W, np.float32)
    bot = np.zeros(W, np.float32)
    has = np.zeros(W, bool)
    for x in range(W):
        col = np.nonzero(mouth[:, x])[0]
        if len(col) == 0:
            continue
        # самый длинный непрерывный тёмный участок (игнорируем щели между зубами)
        splits = np.split(col, np.nonzero(np.diff(col) > 1)[0] + 1)
        run = max(splits, key=len)
        top[x], bot[x], has[x] = run[0], run[-1], True
    xs = np.nonzero(has)[0]
    gap = np.where(has, bot - top, 0).astype(np.float32)
    # сглаживаем профиль, чтобы уголки рта сходились плавно
    k = cv2.getGaussianKernel(smooth * 6 + 1, smooth).ravel()
    gap = np.convolve(gap, k, mode="same")
    fill = lambda a: np.interp(np.arange(W), xs, a[xs])  # noqa: E731
    top_s = np.convolve(fill(top), k, mode="same")
    bot_s = np.convolve(fill(bot), k, mode="same")
    # по краям convolve занижает значения — используем интерполированные исходники
    top_s[: xs[0]] = top[xs[0]]
    top_s[xs[-1]:] = top[xs[-1]]
    bot_s[: xs[0]] = bot[xs[0]]
    bot_s[xs[-1]:] = bot[xs[-1]]

    Y = np.arange(H, dtype=np.float32)[:, None]
    lower = gap * (1 - upper_share)
    upper = gap * upper_share
    seam = top_s + upper  # где встречаются губы при закрытом рте

    # нижняя часть: src = y + lower, затухание к низу апельсина
    fade_len = np.maximum(by1 - (bot_s + 10), 1.0)
    t = np.clip((Y - (bot_s + 10)) / fade_len, 0, 1)
    w_low = np.where(Y >= seam, 1 - t, 0)
    # верхняя часть: src = y - upper, затухание вверх
    up_len = np.maximum(gap.max() * 2.2, 40)
    tu = np.clip((top_s - Y) / up_len, 0, 1)
    w_up = np.where(Y < seam, 1 - tu, 0)
    D = lower * w_low - upper * w_up
    D = cv2.GaussianBlur(D.astype(np.float32), (0, 0), 1.5)
    return D


def build_eyes(img, eyes, hull, pad=10):
    """Маска каждого глаза + текстура века: чистый участок кожи рядом, подогнанный по цвету."""
    H, W = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    skin = ((hsv[..., 0] < 30) & (hsv[..., 1] > 120) & (hsv[..., 2] > 90)).astype(np.uint8) & hull
    feat = np.zeros((H, W), np.uint8)  # глаза (с запасом) нельзя брать как источник кожи
    for (x, y, w, h) in eyes:
        cv2.rectangle(feat, (x - 2 * pad, y - 2 * pad), (x + w + 2 * pad, y + h + 2 * pad), 1, -1)
    ok = skin & (1 - feat)
    integ = cv2.integral(ok)
    out = []
    for (x, y, w, h) in eyes:
        m = np.zeros((H, W), np.float32)
        cx, cy = int(x + w / 2), int(y + h / 2)
        cv2.ellipse(m, (cx, cy), (int(w / 2 + pad), int(h / 2 + pad)), 0, 0, 360, 1.0, -1)
        m = cv2.GaussianBlur(m, (0, 0), 2.5)
        x0, y0, x1, y1 = x - pad, y - pad, x + w + pad, y + h + pad
        best = None
        for dy in range(-3 * (y1 - y0), (y1 - y0) + 1, 3):
            for dx in range(-(x1 - x0), (x1 - x0) + 1, 6):
                a0, b0, a1, b1 = x0 + dx, y0 + dy, x1 + dx, y1 + dy
                if a0 < 0 or b0 < 0 or a1 >= W or b1 >= H:
                    continue
                area = (a1 - a0) * (b1 - b0)
                good = integ[b1, a1] - integ[b0, a1] - integ[b1, a0] + integ[b0, a0]
                if good >= 0.995 * area:
                    cost = abs(dy) + 1.5 * abs(dx) + (40 if dy > 0 else 0)  # ближе и лучше сверху
                    if best is None or cost < best[0]:
                        best = (cost, dx, dy)
        dx, dy = (0, -(y1 - y0)) if best is None else best[1:]
        M = np.float32([[1, 0, -dx], [0, 1, -dy]])
        tex = cv2.warpAffine(img, M, (W, H), borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        # подгоняем цвет под кожу вокруг глаза
        ring = (cv2.dilate((m > 0.5).astype(np.uint8), np.ones((15, 15), np.uint8)) > 0) & (m < 0.05) & (skin > 0)
        inside = m > 0.5
        tex += img[ring].astype(np.float32).mean(0) - tex[inside].mean(0)
        out.append((m, float(y0), float(y1 - y0), tex))
    return out


def blink_schedule(n_frames, fps, seed=7):
    rng = np.random.default_rng(seed)
    b = np.zeros(n_frames, np.float32)
    shape = np.array([0.45, 1.0, 1.0, 0.6, 0.25])  # закрыть-открыть ~5 кадров
    t = rng.uniform(0.8, 2.0)
    while True:
        i = int(t * fps)
        if i >= n_frames:
            break
        for j, v in enumerate(shape):
            if i + j < n_frames:
                b[i + j] = max(b[i + j], v)
        t += rng.uniform(2.0, 5.0)
    return b


def apply_blink(frame, eyes, amount):
    if amount <= 0.01:
        return frame
    H, W = frame.shape[:2]
    Y, X = np.mgrid[0:H, 0:W].astype(np.float32)
    out = frame.astype(np.float32)
    for m, ey, eh, tex in eyes:
        lid = ey + amount * eh  # положение края века
        # веко: текстура кожи, слегка затемнённая к краю для объёма
        shade = 1 - 0.18 * np.exp(-np.maximum(lid - Y, 0) / 10.0)
        skin = tex * shade[..., None]
        cover = np.clip((lid - Y) / 2.0 + 0.5, 0, 1) * m
        out = out * (1 - cover[..., None]) + skin * cover[..., None]
        # ресницы: по краю века, при закрытии превращаются в дугу «улыбкой»
        cx = float((m.sum(0) * np.arange(W)).sum() / m.sum())
        hw = float((m.max(0) > 0.5).sum()) / 2
        u = np.clip((X - cx) / max(hw, 1), -1, 1)
        arc = ey + eh * (0.62 + 0.18 * (1 - u ** 2) * min(1.0, amount))
        line_y = np.minimum(lid, arc)
        inner = np.clip(m * 1.6 - 0.3, 0, 1) * (1 - u ** 2) ** 0.3
        edge = np.exp(-((Y - line_y) ** 2) / (2 * 1.8 ** 2)) * inner * min(1.0, amount * 1.5)
        out *= (1 - 0.6 * edge[..., None])
    return np.clip(out, 0, 255).astype(np.uint8)


# ----------------------------------------------------------------------------- render
def main():
    ap = argparse.ArgumentParser(description="Липсинк говорящего апельсина")
    ap.add_argument("audio", help="аудио с речью (wav/mp3/ogg/m4a — всё, что читает ffmpeg)")
    ap.add_argument("-o", "--output", default="orange_talking.mp4")
    ap.add_argument("--image", default=os.path.join(HERE, "orange.png"))
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--max-open", type=float, default=1.0,
                    help="макс. открытость рта (1.0 = как на фото, >1 — шире фото)")
    ap.add_argument("--min-open", type=float, default=0.0, help="открытость в тишине")
    ap.add_argument("--sensitivity", type=float, default=1.0, help=">1 — рот открывается сильнее")
    ap.add_argument("--no-blink", action="store_true")
    ap.add_argument("--no-bob", action="store_true", help="без покачивания")
    ap.add_argument("--debug-mask", action="store_true", help="сохранить картинку с найденными зонами и выйти")
    ap.add_argument("--preview", action="store_true", help="показать окно с превью во время рендера")
    ap.add_argument("--ffmpeg", default=None)
    args = ap.parse_args()

    ffmpeg = find_ffmpeg(args.ffmpeg)
    img = cv2.imread(args.image, cv2.IMREAD_COLOR)
    if img is None:
        sys.exit(f"Не могу прочитать {args.image}")
    H, W = img.shape[:2]
    if W % 2 or H % 2:  # yuv420p требует чётных размеров
        img = cv2.copyMakeBorder(img, 0, H % 2, 0, W % 2, cv2.BORDER_REPLICATE)
        H, W = img.shape[:2]

    feats = detect_features(img)
    D = build_mouth_field(feats["mouth"], feats["body"])
    eyes = build_eyes(img, feats["eyes"], feats["hull"])

    if args.debug_mask:
        dbg = img.copy()
        dbg[feats["mouth"] > 0] = (0, 0, 255)
        for (x, y, w, h) in feats["eyes"]:
            cv2.rectangle(dbg, (x, y), (x + w, y + h), (255, 0, 0), 2)
        Yg, Xg = np.mgrid[0:H, 0:W].astype(np.float32)
        closed = cv2.remap(img, Xg, Yg + D, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        half = cv2.remap(img, Xg, Yg + 0.5 * D, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        out = os.path.splitext(args.output)[0] + "_debug.png"
        cv2.imwrite(out, np.hstack([dbg, half, closed]))
        print("debug:", out)
        return

    audio, sr = load_audio(args.audio, ffmpeg)
    if len(audio) == 0:
        sys.exit("Пустое аудио")
    o = mouth_curve(audio, sr, args.fps)
    o = np.clip(o * args.sensitivity, 0, 1)
    o = args.min_open + (args.max_open - args.min_open) * o
    n = len(o)
    blinks = np.zeros(n) if args.no_blink else blink_schedule(n, args.fps)
    print(f"аудио {len(audio) / sr:.2f} c, кадров {n}, глаз найдено {len(eyes)}")

    Yg, Xg = np.mgrid[0:H, 0:W].astype(np.float32)
    bx0, by0, bx1, by1 = feats["body"]
    pivot = ((bx0 + bx1) / 2.0, float(by1))  # «стоит» на нижней точке
    talk = np.convolve(o, np.ones(6) / 6, mode="same")  # медленная огибающая для движения

    enc = subprocess.Popen([
        ffmpeg, "-v", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(args.fps), "-i", "-",
        "-i", args.audio,
        "-map", "0:v", "-map", "1:a",
        "-vf", "scale=640:640",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart",
        args.output,
    ], stdin=subprocess.PIPE)

    try:
        for i in range(n):
            c = 1.0 - o[i]
            frame = cv2.remap(img, Xg, (Yg + c * D).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            if not args.no_blink:
                frame = apply_blink(frame, eyes, float(blinks[i]))
            if not args.no_bob:
                t = i / args.fps
                ang = 1.2 * np.sin(t * 1.3) + 2.5 * talk[i] * np.sin(t * 7.0)
                sy = 1.0 + 0.025 * talk[i]       # вытягивается, когда говорит
                sx = 1.0 - 0.012 * talk[i]
                M = cv2.getRotationMatrix2D(pivot, ang, 1.0)
                S = np.array([[sx, 0, pivot[0] * (1 - sx)], [0, sy, pivot[1] * (1 - sy)]], np.float32)
                M3 = np.vstack([M, [0, 0, 1]]) @ np.vstack([S, [0, 0, 1]])
                frame = cv2.warpAffine(frame, M3[:2], (W, H), flags=cv2.INTER_LINEAR,
                                       borderMode=cv2.BORDER_REPLICATE)
            enc.stdin.write(frame.tobytes())
            if args.preview:
                cv2.imshow("orange", frame)
                if cv2.waitKey(1) == 27:
                    break
            if i % (args.fps * 2) == 0:
                print(f"\r{i}/{n}", end="", flush=True)
    finally:
        enc.stdin.close()
        code = enc.wait()
        if args.preview:
            cv2.destroyAllWindows()
    if code:
        sys.exit(f"FFmpeg завершился с ошибкой: {code}")
    print(f"\rготово: {args.output}")


if __name__ == "__main__":
    main()
