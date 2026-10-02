"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Camera,
  ChevronLeft,
  Circle,
  ChevronRight,
  Copy,
  Download,
  Eraser,
  FlipHorizontal2,
  Hand,
  Highlighter,
  Images,
  Keyboard,
  LoaderCircle,
  Maximize,
  Minimize,
  Pause,
  Pen,
  Play,
  Redo2,
  RefreshCw,
  RotateCw,
  SlidersHorizontal,
  Trash2,
  Type,
  Undo2,
  Video,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  QUALITY_LABEL,
  cameraErrorMessage,
  listCameras,
  openCamera,
  pickBest,
  scoreCamera,
  type Quality,
  type SavedCamera,
} from "@/lib/camera";
import { TEXT_FONT, renderAnnotations, type Pt, type Stroke } from "@/lib/annotations";
import {
  clearCaptures,
  deleteCapture,
  deleteRecording,
  loadCaptures,
  loadRecordings,
  saveCapture,
  saveRecording,
  type StoredRecording,
} from "@/lib/captureStore";
import { RecordBadge, RecordPanel, formatDuration, useRecorder, type NewRecording } from "@/components/Recorder";
import { SHORTCUT_GROUPS } from "@/lib/shortcuts";

type Tool = "move" | "pen" | "highlighter" | "eraser" | "text";
type Capture = { id: string; createdAt: number; blob: Blob; url: string };
type Recording = StoredRecording & { url: string };
type View = { zoom: number; pan: { x: number; y: number } };
type Hist = { cur: Stroke[]; past: Stroke[][]; future: Stroke[][] };
type Gesture =
  | { type: "pan"; x0: number; y0: number; pan0: View["pan"] }
  | { type: "pinch"; d0: number; m0: { x: number; y: number }; zoom0: number; pan0: View["pan"] }
  | { type: "draw" };

const COLORS = ["#ef4444", "#2563eb", "#111827", "#16a34a", "#facc15", "#ffffff"];
const COLOR_NAMES = ["빨강", "파랑", "검정", "초록", "노랑", "흰색"];
const PEN_PX = { s: 3, m: 6, l: 12 } as const; // 화면 기준 굵기
const TEXT_PX = 32;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 12;
const LS_CAM = "doccam.camera";
const LS_QUALITY = "doccam.quality";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function lsGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}
function readSavedCam(): SavedCamera | null {
  try {
    return JSON.parse(lsGet(LS_CAM) ?? "null");
  } catch {
    return null;
  }
}

function fileName(t: number, ext: string, prefix = "실물화상기") {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${prefix}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
}
function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function canvasToBlob(c: HTMLCanvasElement, type: string, q?: number) {
  return new Promise<Blob>((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob 실패"))), type, q),
  );
}
async function blobToPng(blob: Blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  return canvasToBlob(c, "image/png");
}
function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
const stopStream = (s: MediaStream | null) => s?.getTracks().forEach((t) => t.stop());

export default function DocCam() {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const annoRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const seqRef = useRef(0);

  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [camId, setCamId] = useState("");
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [error, setError] = useState("");
  const [quality, setQuality] = useState<Quality>(() => (lsGet(LS_QUALITY) as Quality) || "1080");
  const [vsize, setVsize] = useState({ w: 1920, h: 1080 });
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ zoom: 1, pan: { x: 0, y: 0 } });
  const [rot, setRot] = useState(0); // 90° 단위 0~3
  const [mirror, setMirror] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [bright, setBright] = useState(1);
  const [contrast, setContrast] = useState(1);
  const [tool, setTool] = useState<Tool>("move");
  const [color, setColor] = useState(COLORS[0]);
  const [penSize, setPenSize] = useState<keyof typeof PEN_PX>("m");
  const [hist, setHist] = useState<Hist>({ cur: [], past: [], future: [] });
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryTab, setGalleryTab] = useState<"photo" | "video">("photo");
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const playerRef = useRef<HTMLVideoElement>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [captureAnno, setCaptureAnno] = useState(true);
  const [toast, setToast] = useState<{ msg: string; key: number } | null>(null);
  const [flash, setFlash] = useState(0);
  const [uiVisible, setUiVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [trackInfo, setTrackInfo] = useState("");
  const [textDraft, setTextDraft] = useState<{ sx: number; sy: number; vx: number; vy: number; value: string } | null>(
    null,
  );

  // ---- 화면 변환: 반전(F) · 회전(R) · 배율(S) ----
  const quarter = rot % 2 === 1;
  const rw = quarter ? vsize.h : vsize.w;
  const rh = quarter ? vsize.w : vsize.h;
  const fit = vp.w && vp.h ? Math.min(vp.w / rw, vp.h / rh) : 1;
  const S = fit * view.zoom;
  const angle = (rot * Math.PI) / 2;
  const m = mirror ? -1 : 1;
  const filterCss = `brightness(${bright}) contrast(${contrast})`;
  const stageTransform = `translate(${vp.w / 2 + view.pan.x}px, ${vp.h / 2 + view.pan.y}px) scale(${m}, 1) rotate(${
    rot * 90
  }deg) scale(${S}) translate(${-vsize.w / 2}px, ${-vsize.h / 2}px)`;

  // 이벤트 핸들러가 항상 최신 값을 보도록
  const L = useRef({
    vp, vsize, view, S, angle, m, mirror, rot, tool, color, penSize, strokes: hist.cur, cams, camId, quality,
    frozen, captures, viewing, helpOpen, settingsOpen, galleryOpen, captureAnno, filterCss, bright, textDraft,
    recordings, playing,
  });
  useLayoutEffect(() => {
    L.current = {
      vp, vsize, view, S, angle, m, mirror, rot, tool, color, penSize, strokes: hist.cur, cams, camId, quality,
      frozen, captures, viewing, helpOpen, settingsOpen, galleryOpen, captureAnno, filterCss, bright, textDraft,
    recordings, playing,
    };
  });

  // ---- 알림 ----
  const toastTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((msg: string) => {
    setToast({ msg, key: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  // ---- 카메라 연결 ----
  const attach = useCallback((stream: MediaStream) => {
    streamRef.current = stream;
    const track = stream.getVideoTracks()[0];
    const st = track?.getSettings() ?? {};
    setCamId(st.deviceId ?? "");
    setTrackInfo(st.width ? `${st.width}×${st.height}${st.frameRate ? ` · ${Math.round(st.frameRate)}fps` : ""}` : "");
    track?.addEventListener("ended", () => {
      if (streamRef.current !== stream) return;
      setStatus("error");
      setError("카메라 연결이 끊어졌어요. USB를 다시 꽂으면 자동으로 연결돼요.");
    });
    const v = videoRef.current;
    if (v) {
      v.srcObject = stream;
      v.play().catch(() => {});
    }
    setFrozen(false);
    setStatus("live");
  }, []);

  const connect = useCallback(
    async (preferId?: string) => {
      const seq = ++seqRef.current;
      stopStream(streamRef.current);
      streamRef.current = null;
      setStatus("connecting");
      setError("");
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("error");
        setError("이 브라우저에서는 카메라를 쓸 수 없어요. 크롬이나 엣지에서 https 주소로 열어 주세요.");
        return;
      }
      const q = L.current.quality;
      const saved = readSavedCam();
      let stream: MediaStream | null = null;
      try {
        let list = await listCameras();
        // 권한 전에는 이름·ID가 비어 있으므로, 일단 열고 나서 다시 고른다
        const first = preferId ?? pickBest(list.filter((c) => c.deviceId), saved)?.deviceId;
        stream = await openCamera(first || undefined, q);
        if (seq !== seqRef.current) return stopStream(stream);
        list = await listCameras();
        if (!preferId) {
          const best = pickBest(list, saved);
          const cur = stream.getVideoTracks()[0]?.getSettings().deviceId;
          if (best?.deviceId && best.deviceId !== cur) {
            stopStream(stream);
            stream = null;
            stream = await openCamera(best.deviceId, q);
            if (seq !== seqRef.current) return stopStream(stream);
          }
        }
        setCams(list);
        attach(stream);
      } catch (err) {
        if (seq !== seqRef.current) return stopStream(stream);
        try {
          setCams(await listCameras());
        } catch {}
        setStatus("error");
        setError(cameraErrorMessage(err));
      }
    },
    [attach],
  );

  const selectCam = useCallback(
    (id: string) => {
      const c = L.current.cams.find((x) => x.deviceId === id);
      lsSet(LS_CAM, JSON.stringify({ id, label: c?.label ?? "" }));
      connect(id);
    },
    [connect],
  );

  // 처음 열 때 연결 + 저장된 캡처 불러오기
  useEffect(() => {
    const seqBox = seqRef;
    // 카메라는 외부 시스템이라 마운트 시 연결이 맞다 (연결 결과로 상태가 바뀜)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    connect();
    loadCaptures().then((list) =>
      setCaptures((prev) => [
        ...prev,
        ...list.filter((c) => !prev.some((p) => p.id === c.id)).map((c) => ({ ...c, url: URL.createObjectURL(c.blob) })),
      ]),
    );
    loadRecordings().then((list) =>
      setRecordings((prev) => [
        ...prev,
        ...list.filter((r) => !prev.some((p) => p.id === r.id)).map((r) => ({ ...r, url: URL.createObjectURL(r.blob) })),
      ]),
    );
    return () => {
      seqBox.current++;
      stopStream(streamRef.current);
    };
  }, [connect]);

  // USB 카메라를 꽂거나 뽑으면 자동으로 따라간다
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md) return;
    let t: number | undefined;
    const onChange = () => {
      clearTimeout(t);
      t = window.setTimeout(async () => {
        const prev = L.current.cams;
        const list = await listCameras();
        setCams(list);
        const curTrack = streamRef.current?.getVideoTracks()[0];
        const alive = curTrack?.readyState === "live" && list.some((c) => c.deviceId === L.current.camId);
        if (!alive) {
          if (list.length) {
            notify("카메라가 바뀌어서 다시 연결할게요");
            connect();
          } else {
            setStatus("error");
            setError("연결된 카메라가 없어요. USB를 꽂으면 자동으로 연결돼요.");
          }
          return;
        }
        const curLabel = list.find((c) => c.deviceId === L.current.camId)?.label ?? "";
        const better = list
          .filter((c) => c.label && !prev.some((p) => p.deviceId === c.deviceId))
          .filter((c) => scoreCamera(c.label) > scoreCamera(curLabel))
          .pop();
        if (better) {
          notify(`새 카메라로 바꿨어요: ${better.label}`);
          connect(better.deviceId);
        }
      }, 700);
    };
    md.addEventListener("devicechange", onChange);
    return () => {
      clearTimeout(t);
      md.removeEventListener("devicechange", onChange);
    };
  }, [connect, notify]);

  // 수업 중 화면 꺼짐 방지
  useEffect(() => {
    if (status !== "live" || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const req = () => navigator.wakeLock.request("screen").then((l) => (lock = l)).catch(() => {});
    const onVis = () => document.visibilityState === "visible" && req();
    req();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      lock?.release().catch(() => {});
    };
  }, [status]);

  // 화면 크기 추적
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setVp({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // ---- 좌표 변환 ----
  const toVideo = useCallback((sx: number, sy: number): Pt => {
    const { vp, view, S, angle, m, vsize } = L.current;
    const dx = (sx - vp.w / 2 - view.pan.x) * m;
    const dy = sy - vp.h / 2 - view.pan.y;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [(dx * c + dy * s) / S + vsize.w / 2, (-dx * s + dy * c) / S + vsize.h / 2];
  }, []);

  // ---- 판서 그리기 ----
  const drawing = useRef<Stroke | null>(null);
  const rafRef = useRef(0);
  const redraw = useCallback(() => {
    const c = annoRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const list = drawing.current ? [...L.current.strokes, drawing.current] : L.current.strokes;
    renderAnnotations(ctx, list, c.width, c.height);
  }, []);
  const scheduleRedraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      redraw();
    });
  }, [redraw]);
  useEffect(() => redraw(), [hist.cur, vsize, redraw]);

  const commitStrokes = useCallback((fn: (cur: Stroke[]) => Stroke[]) => {
    setHist((h) => ({ cur: fn(h.cur), past: [...h.past.slice(-99), h.cur], future: [] }));
  }, []);
  const undo = useCallback(
    () =>
      setHist((h) =>
        h.past.length ? { cur: h.past[h.past.length - 1], past: h.past.slice(0, -1), future: [h.cur, ...h.future] } : h,
      ),
    [],
  );
  const redo = useCallback(
    () =>
      setHist((h) => (h.future.length ? { cur: h.future[0], past: [...h.past, h.cur], future: h.future.slice(1) } : h)),
    [],
  );
  const clearAnno = useCallback(() => {
    if (!L.current.strokes.length) return;
    commitStrokes(() => []);
    notify("판서를 모두 지웠어요 (Ctrl+Z로 되돌리기)");
  }, [commitStrokes, notify]);

  const commitText = useCallback(() => {
    const d = L.current.textDraft;
    setTextDraft(null);
    if (!d || !d.value.trim()) return;
    const { S, angle, mirror, color } = L.current;
    commitStrokes((cur) => [
      ...cur,
      { kind: "text", x: d.vx, y: d.vy, text: d.value.replace(/\s+$/, ""), color, size: TEXT_PX / S, rot: angle, mirror },
    ]);
  }, [commitStrokes]);

  // ---- 보기 조작 ----
  const zoomAt = useCallback((f: number, sx?: number, sy?: number) => {
    setView((v) => {
      const z = clamp(v.zoom * f, MIN_ZOOM, MAX_ZOOM);
      const r = z / v.zoom;
      const { w, h } = L.current.vp;
      const qx = (sx ?? w / 2) - w / 2;
      const qy = (sy ?? h / 2) - h / 2;
      return { zoom: z, pan: { x: qx - (qx - v.pan.x) * r, y: qy - (qy - v.pan.y) * r } };
    });
  }, []);
  const resetView = useCallback(() => setView({ zoom: 1, pan: { x: 0, y: 0 } }), []);
  const panBy = useCallback((dx: number, dy: number) => setView((v) => ({ ...v, pan: { x: v.pan.x + dx, y: v.pan.y + dy } })), []);
  const rotate = useCallback((dir: 1 | -1) => {
    // 반전 상태에서는 회전 방향이 뒤집히므로 보정
    setRot((r) => (r + (L.current.mirror ? -dir : dir) + 4) % 4);
    setView((v) => ({ ...v, pan: dir === 1 ? { x: -v.pan.y, y: v.pan.x } : { x: v.pan.y, y: -v.pan.x } }));
  }, []);
  const toggleMirror = useCallback(() => {
    setMirror((x) => !x);
    setView((v) => ({ ...v, pan: { x: -v.pan.x, y: v.pan.y } }));
  }, []);
  const toggleFreeze = useCallback(() => {
    const v = videoRef.current;
    if (!v || !streamRef.current) return;
    if (L.current.frozen) {
      v.play().catch(() => {});
      setFrozen(false);
    } else {
      v.pause();
      setFrozen(true);
    }
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else rootRef.current?.requestFullscreen().catch(() => {});
  }, []);
  const nextCam = useCallback(() => {
    const { cams, camId } = L.current;
    if (cams.length < 2) return notify("다른 카메라가 없어요");
    const next = cams[(cams.findIndex((c) => c.deviceId === camId) + 1) % cams.length];
    notify(`카메라: ${next.label || "카메라"}`);
    selectCam(next.deviceId);
  }, [notify, selectCam]);
  const changeBright = useCallback((d: number) => {
    const b = Math.round(clamp(L.current.bright + d, 0.3, 2) * 10) / 10;
    setBright(b);
    notify(`밝기 ${Math.round(b * 100)}%`);
  }, [notify]);

  // ---- 캡처 ----
  const renderFrame = useCallback((mode: "view" | "full", withAnno: boolean) => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !streamRef.current) return null;
    const { vp, view, S, angle, m, vsize, filterCss } = L.current;
    const { w, h } = vsize;
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d")!;
    if (mode === "full") {
      const q = Math.round(angle / (Math.PI / 2)) % 2 === 1;
      c.width = q ? h : w;
      c.height = q ? w : h;
      ctx.translate(c.width / 2, c.height / 2);
      ctx.scale(m, 1);
      ctx.rotate(angle);
      ctx.translate(-w / 2, -h / 2);
    } else {
      // 보이는 영역 중 영상이 있는 부분만 잘라낸다(검은 여백 제외)
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) {
        const ax = (px - w / 2) * S;
        const ay = (py - h / 2) * S;
        xs.push((ax * cos - ay * sin) * m + vp.w / 2 + view.pan.x);
        ys.push(ax * sin + ay * cos + vp.h / 2 + view.pan.y);
      }
      const x0 = Math.max(0, Math.min(...xs));
      const y0 = Math.max(0, Math.min(...ys));
      const x1 = Math.min(vp.w, Math.max(...xs));
      const y1 = Math.min(vp.h, Math.max(...ys));
      if (x1 - x0 < 2 || y1 - y0 < 2) return null;
      // 원본 해상도를 살리되 너무 커지지 않게
      const k = Math.min(Math.max(1 / S, window.devicePixelRatio || 1), 4096 / Math.max(x1 - x0, y1 - y0));
      c.width = Math.round((x1 - x0) * k);
      c.height = Math.round((y1 - y0) * k);
      ctx.scale(k, k);
      ctx.translate(-x0 + vp.w / 2 + view.pan.x, -y0 + vp.h / 2 + view.pan.y);
      ctx.scale(m, 1);
      ctx.rotate(angle);
      ctx.scale(S, S);
      ctx.translate(-w / 2, -h / 2);
    }
    ctx.imageSmoothingQuality = "high";
    ctx.filter = filterCss;
    ctx.drawImage(v, 0, 0, w, h);
    ctx.filter = "none";
    if (withAnno && annoRef.current) ctx.drawImage(annoRef.current, 0, 0, w, h);
    return c;
  }, []);

  const capture = useCallback(
    async (mode: "view" | "full" = "view") => {
      const c = renderFrame(mode, L.current.captureAnno);
      if (!c) {
        notify("카메라 화면이 아직 없어요");
        return null;
      }
      const blob = await canvasToBlob(c, "image/jpeg", 0.92);
      const cap: Capture = { id: newId(), createdAt: Date.now(), blob, url: URL.createObjectURL(blob) };
      setCaptures((p) => [cap, ...p]);
      saveCapture({ id: cap.id, createdAt: cap.createdAt, blob });
      setFlash((f) => f + 1);
      notify(`${mode === "full" ? "전체 화면을 " : ""}캡처했어요 · ${L.current.captures.length + 1}장 (G로 목록)`);
      return cap;
    },
    [renderFrame, notify],
  );

  const copyView = useCallback(async () => {
    const c = renderFrame("view", L.current.captureAnno);
    if (!c) return notify("카메라 화면이 아직 없어요");
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": canvasToBlob(c, "image/png") })]);
      setFlash((f) => f + 1);
      notify("화면을 복사했어요 · 다른 곳에 Ctrl+V로 붙여 넣으세요");
    } catch {
      notify("복사가 막혀 있어요. 캡처(S) 후 저장해 주세요");
    }
  }, [renderFrame, notify]);

  const copyCapture = useCallback(
    async (cap: Capture) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blobToPng(cap.blob) })]);
        notify("복사했어요 · Ctrl+V로 붙여 넣으세요");
      } catch {
        notify("복사가 막혀 있어요. 저장 버튼을 써 주세요");
      }
    },
    [notify],
  );

  const downloadCapture = useCallback((cap: Capture) => downloadBlob(cap.blob, fileName(cap.createdAt, "jpg")), []);

  const saveLast = useCallback(async () => {
    const cap = L.current.captures[0] ?? (await capture());
    if (cap) {
      downloadCapture(cap);
      notify("마지막 캡처를 저장했어요 (다운로드 폴더)");
    }
  }, [capture, downloadCapture, notify]);

  const removeCapture = useCallback((id: string) => {
    setCaptures((p) => {
      const target = p.find((c) => c.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return p.filter((c) => c.id !== id);
    });
    deleteCapture(id);
  }, []);

  const removeAllCaptures = useCallback(() => {
    if (!confirm(`캡처 ${L.current.captures.length}장을 모두 지울까요? 되돌릴 수 없어요.`)) return;
    setCaptures((p) => {
      p.forEach((c) => URL.revokeObjectURL(c.url));
      return [];
    });
    setViewing(null);
    clearCaptures();
  }, []);

  const moveViewing = useCallback((d: number) => {
    const { captures, viewing } = L.current;
    const i = captures.findIndex((c) => c.id === viewing);
    if (i < 0) return;
    setViewing(captures[clamp(i + d, 0, captures.length - 1)].id);
  }, []);

  const deleteViewing = useCallback(() => {
    const { captures, viewing } = L.current;
    const i = captures.findIndex((c) => c.id === viewing);
    if (i < 0) return;
    const rest = captures.filter((c) => c.id !== viewing);
    setViewing(rest.length ? rest[Math.min(i, rest.length - 1)].id : null);
    removeCapture(captures[i].id);
  }, [removeCapture]);

  // ---- 녹화 ----
  // 실물화상기 녹화: 지금 화면(확대·회전·판서 포함)을 녹화용 캔버스에 그대로 그린다
  const paintView = useCallback((ctx: CanvasRenderingContext2D, cw: number, ch: number) => {
    const { vp, view, S, angle, m, vsize, filterCss } = L.current;
    const v = videoRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    if (!v || !v.videoWidth || !streamRef.current || !vp.w || !vp.h) return;
    const k = Math.min(cw / vp.w, ch / vp.h);
    ctx.translate((cw - vp.w * k) / 2, (ch - vp.h * k) / 2);
    ctx.scale(k, k);
    ctx.translate(vp.w / 2 + view.pan.x, vp.h / 2 + view.pan.y);
    ctx.scale(m, 1);
    ctx.rotate(angle);
    ctx.scale(S, S);
    ctx.translate(-vsize.w / 2, -vsize.h / 2);
    ctx.filter = filterCss;
    ctx.drawImage(v, 0, 0, vsize.w, vsize.h);
    ctx.filter = "none";
    if (annoRef.current) ctx.drawImage(annoRef.current, 0, 0, vsize.w, vsize.h);
  }, []);

  // 녹화 해상도: 화면 비율 그대로, 최대 1920×1080 (짝수로 맞춰야 인코더가 받는다)
  const getRecordSize = useCallback(() => {
    const { vp } = L.current;
    const w = vp.w || 1280;
    const h = vp.h || 720;
    const k = Math.min(1920 / w, 1080 / h, window.devicePixelRatio || 1);
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    return { width: even(w * k), height: even(h * k) };
  }, []);

  const onRecorded = useCallback(
    (r: NewRecording) => {
      const rec: Recording = { ...r, id: newId(), url: URL.createObjectURL(r.blob) };
      setRecordings((p) => [rec, ...p]);
      saveRecording({ id: rec.id, createdAt: rec.createdAt, blob: rec.blob, ext: rec.ext, durationMs: rec.durationMs });
      setPlaying(rec.id);
      notify(`녹화를 저장했어요 (${formatDuration(r.durationMs)}) · 저장 버튼으로 파일 받기`);
    },
    [notify],
  );

  const recorder = useRecorder({ paint: paintView, getCameraSize: getRecordSize, notify, onSaved: onRecorded });

  const downloadRecording = useCallback(
    (r: Recording) => downloadBlob(r.blob, fileName(r.createdAt, r.ext, "녹화")),
    [],
  );
  const removeRecording = useCallback((id: string) => {
    if (!confirm("이 녹화 영상을 지울까요? 되돌릴 수 없어요.")) return;
    setRecordings((p) => {
      const target = p.find((r) => r.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return p.filter((r) => r.id !== id);
    });
    setPlaying((cur) => (cur === id ? null : cur));
    deleteRecording(id);
  }, []);

  const pickTool = useCallback((t: Tool) => {
    setTool(t);
    setTextDraft(null);
  }, []);

  // ---- 단축키 ----
  const actions = useRef({
    toggleFreeze, toggleFullscreen, rotate, toggleMirror, nextCam, zoomAt, resetView, panBy, changeBright, capture,
    copyView, saveLast, undo, redo, clearAnno, pickTool, moveViewing, deleteViewing, downloadCapture, copyCapture,
    recorder, downloadRecording, removeRecording,
  });
  useLayoutEffect(() => {
    actions.current = {
      toggleFreeze, toggleFullscreen, rotate, toggleMirror, nextCam, zoomAt, resetView, panBy, changeBright, capture,
      copyView, saveLast, undo, redo, clearAnno, pickTool, moveViewing, deleteViewing, downloadCapture, copyCapture,
    recorder, downloadRecording, removeRecording,
    };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable)) return;
      const a = actions.current;
      const l = L.current;
      const mod = e.metaKey || e.ctrlKey;
      const code = e.code;

      if (l.playing) {
        const r = l.recordings.find((x) => x.id === l.playing);
        const pv = playerRef.current;
        if (code === "Escape") setPlaying(null);
        else if (code === "Space" && pv) {
          if (pv.paused) pv.play().catch(() => {});
          else pv.pause();
        } else if ((code === "Delete" || code === "Backspace") && r) a.removeRecording(r.id);
        else if (mod && code === "KeyS" && r) a.downloadRecording(r);
        else return;
        e.preventDefault();
        return;
      }

      if (l.viewing) {
        const cap = l.captures.find((c) => c.id === l.viewing);
        if (code === "Escape") setViewing(null);
        else if (code === "ArrowLeft") a.moveViewing(-1);
        else if (code === "ArrowRight") a.moveViewing(1);
        else if (code === "Delete" || code === "Backspace") a.deleteViewing();
        else if (mod && code === "KeyS" && cap) a.downloadCapture(cap);
        else if (mod && code === "KeyC" && cap) a.copyCapture(cap);
        else return;
        e.preventDefault();
        return;
      }

      if (mod) {
        if (code === "KeyZ") (e.shiftKey ? a.redo : a.undo)();
        else if (code === "KeyY") a.redo();
        else if (code === "KeyS") a.saveLast();
        else if (code === "KeyC" && !window.getSelection()?.toString()) a.copyView();
        else return;
        e.preventDefault();
        return;
      }
      if (e.altKey) return;

      const big = e.shiftKey ? 240 : 80;
      switch (code) {
        case "Space": a.toggleFreeze(); break;
        case "KeyF": a.toggleFullscreen(); break;
        case "KeyR": a.rotate(e.shiftKey ? -1 : 1); break;
        case "KeyM": a.toggleMirror(); break;
        case "KeyN": a.nextCam(); break;
        case "Equal": case "NumpadAdd": a.zoomAt(1.25); break;
        case "Minus": case "NumpadSubtract": a.zoomAt(0.8); break;
        case "Digit0": case "Numpad0": a.resetView(); break;
        case "ArrowLeft": a.panBy(big, 0); break;
        case "ArrowRight": a.panBy(-big, 0); break;
        case "ArrowUp": a.panBy(0, big); break;
        case "ArrowDown": a.panBy(0, -big); break;
        case "BracketLeft": a.changeBright(-0.1); break;
        case "BracketRight": a.changeBright(0.1); break;
        case "KeyS": case "KeyC": a.capture(e.shiftKey ? "full" : "view"); break;
        case "KeyG": setGalleryOpen((g) => !g); break;
        case "KeyO":
          if (a.recorder.rec) a.recorder.stop();
          else {
            setSettingsOpen(false);
            a.recorder.setPanelOpen((o) => !o);
          }
          break;
        case "KeyV": a.pickTool("move"); break;
        case "KeyP": a.pickTool("pen"); break;
        case "KeyH": a.pickTool("highlighter"); break;
        case "KeyE": a.pickTool("eraser"); break;
        case "KeyT": a.pickTool("text"); break;
        case "KeyX": case "Delete": case "Backspace": a.clearAnno(); break;
        case "Slash": setHelpOpen((h) => !h); break;
        case "Escape":
          if (l.helpOpen) setHelpOpen(false);
          else if (l.settingsOpen) setSettingsOpen(false);
          else if (a.recorder.panelOpen) a.recorder.setPanelOpen(false);
          else a.pickTool("move");
          break;
        default: {
          const n = /^(?:Digit|Numpad)([1-6])$/.exec(code);
          if (!n) return;
          setColor(COLORS[Number(n[1]) - 1]);
          if (l.tool === "move" || l.tool === "eraser") a.pickTool("pen");
        }
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- 마우스·터치 ----
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      // 트랙패드 핀치(ctrlKey)는 더 민감하게
      zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gest = useRef<Gesture | null>(null);
  const rel = (e: React.PointerEvent | PointerEvent) => {
    const r = viewportRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const commitDrawing = () => {
    const s = drawing.current;
    drawing.current = null;
    if (s) commitStrokes((cur) => [...cur, s]);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (textDraft) return; // 글자 입력창 바깥을 누르면 blur로 확정된다
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    const pos = rel(e);
    const l = L.current;
    if (l.tool === "text" && e.button === 0 && ptrs.current.size === 0) {
      e.preventDefault();
      const [vx, vy] = toVideo(pos.x, pos.y);
      setTextDraft({ sx: pos.x, sy: pos.y, vx, vy, value: "" });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, pos);

    if (ptrs.current.size === 2) {
      // 두 손가락 = 확대/이동. 그리던 선은 버린다
      drawing.current = null;
      scheduleRedraw();
      const [a, b] = [...ptrs.current.values()];
      gest.current = {
        type: "pinch",
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        zoom0: l.view.zoom,
        pan0: l.view.pan,
      };
      return;
    }
    if (ptrs.current.size > 2) return;
    if (l.tool === "move" || e.button === 1) {
      gest.current = { type: "pan", x0: pos.x, y0: pos.y, pan0: l.view.pan };
      return;
    }
    const kind = l.tool as "pen" | "highlighter" | "eraser";
    const px = kind === "eraser" ? 36 : kind === "highlighter" ? PEN_PX[l.penSize] * 4 : PEN_PX[l.penSize];
    drawing.current = { kind, color: l.color, size: px / l.S, points: [toVideo(pos.x, pos.y)] };
    gest.current = { type: "draw" };
    scheduleRedraw();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ptrs.current.has(e.pointerId)) return;
    const pos = rel(e);
    ptrs.current.set(e.pointerId, pos);
    const g = gest.current;
    if (!g) return;
    if (g.type === "pinch" && ptrs.current.size >= 2) {
      const [a, b] = [...ptrs.current.values()];
      const z = clamp((g.zoom0 * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0, MIN_ZOOM, MAX_ZOOM);
      const r = z / g.zoom0;
      const { w, h } = L.current.vp;
      const mx = (a.x + b.x) / 2 - w / 2;
      const my = (a.y + b.y) / 2 - h / 2;
      setView({
        zoom: z,
        pan: { x: mx - (g.m0.x - w / 2 - g.pan0.x) * r, y: my - (g.m0.y - h / 2 - g.pan0.y) * r },
      });
    } else if (g.type === "pan") {
      setView((v) => ({ ...v, pan: { x: g.pan0.x + pos.x - g.x0, y: g.pan0.y + pos.y - g.y0 } }));
    } else if (g.type === "draw" && drawing.current && drawing.current.kind !== "text") {
      const pts = drawing.current.points;
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
      const minGap = 0.75 / L.current.S;
      for (const ev of events.length ? events : [e.nativeEvent]) {
        const p = rel(ev);
        const v = toVideo(p.x, p.y);
        const last = pts[pts.length - 1];
        if (Math.hypot(v[0] - last[0], v[1] - last[1]) >= minGap) pts.push(v);
      }
      scheduleRedraw();
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ptrs.current.delete(e.pointerId)) return;
    const g = gest.current;
    if (g?.type === "draw") {
      commitDrawing();
      gest.current = null;
    } else if (g?.type === "pinch" && ptrs.current.size < 2) {
      gest.current = null;
    }
    if (ptrs.current.size === 0) gest.current = null;
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (L.current.tool !== "move") return;
    const r = viewportRef.current!.getBoundingClientRect();
    if (L.current.view.zoom > 1.05) resetView();
    else zoomAt(2.5 / L.current.view.zoom, e.clientX - r.left, e.clientY - r.top);
  };

  // ---- 도구막대 자동 숨김 ----
  const hideTimer = useRef<number | undefined>(undefined);
  const barHover = useRef(false);
  const scheduleHide = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!barHover.current && !L.current.settingsOpen && !actions.current.recorder.panelOpen) setUiVisible(false);
    }, 3000);
  }, []);
  const wake = useCallback(() => {
    setUiVisible(true);
    scheduleHide();
  }, [scheduleHide]);
  useEffect(() => {
    scheduleHide();
    return () => clearTimeout(hideTimer.current);
  }, [scheduleHide]);

  const showUi = uiVisible || status !== "live" || settingsOpen || helpOpen || recorder.panelOpen;
  const viewingIdx = captures.findIndex((c) => c.id === viewing);
  const viewingCap = viewingIdx >= 0 ? captures[viewingIdx] : null;
  const playingRec = recordings.find((r) => r.id === playing) ?? null;
  const curCam = cams.find((c) => c.deviceId === camId);
  const cursor =
    tool === "move"
      ? showUi
        ? "grab"
        : "none"
      : tool === "text"
        ? "text"
        : tool === "eraser"
          ? "cell"
          : "crosshair";

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 flex select-none bg-neutral-950 text-white"
      onPointerMove={wake}
      onPointerDown={wake}
    >
      <div
        ref={viewportRef}
        className="relative flex-1 touch-none overflow-hidden"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ width: vsize.w, height: vsize.h, transform: stageTransform }}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            className="absolute inset-0 h-full w-full"
            style={{ filter: filterCss, visibility: status === "live" ? "visible" : "hidden" }}
            onLoadedMetadata={(e) => setVsize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
            onResize={(e) =>
              e.currentTarget.videoWidth && setVsize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })
            }
          />
          <canvas ref={annoRef} width={vsize.w} height={vsize.h} className="absolute inset-0 h-full w-full" />
        </div>

        {textDraft && (
          <textarea
            autoFocus
            rows={1}
            value={textDraft.value}
            placeholder="글자 입력 후 Enter"
            onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
            onBlur={commitText}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter 무시
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commitText();
              } else if (e.key === "Escape") {
                setTextDraft(null);
              }
            }}
            className="absolute z-20 resize-none overflow-hidden whitespace-pre bg-black/10 p-0 font-bold outline-2 outline-dashed outline-white/70 placeholder:text-white/50"
            style={{
              left: textDraft.sx,
              top: textDraft.sy,
              fontSize: TEXT_PX,
              lineHeight: 1.25,
              fontFamily: TEXT_FONT,
              color,
              minWidth: 260,
              height: TEXT_PX * 1.25 * Math.max(1, textDraft.value.split("\n").length),
              width: Math.max(260, ...textDraft.value.split("\n").map((l) => l.length * TEXT_PX + 20)),
              textShadow: "0 0 3px rgba(255,255,255,.9), 0 0 3px rgba(0,0,0,.6)",
            }}
          />
        )}

        {status === "connecting" && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex items-center gap-3 text-lg text-white/80">
              <LoaderCircle className="animate-spin" /> 카메라 연결 중…
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="absolute inset-0 z-10 grid place-items-center p-6">
            <div className="w-full max-w-lg rounded-2xl bg-neutral-900 p-6 shadow-2xl ring-1 ring-white/10">
              <div className="mb-2 text-xl font-bold">카메라를 열지 못했어요</div>
              <p className="mb-5 leading-relaxed text-white/80">{error}</p>
              {cams.length > 0 && (
                <div className="mb-5">
                  <div className="mb-2 text-sm text-white/60">카메라를 직접 고를 수도 있어요</div>
                  <div className="flex flex-col gap-2">
                    {cams.map((c, i) => (
                      <button
                        key={c.deviceId || i}
                        onClick={() => selectCam(c.deviceId)}
                        className="rounded-lg bg-white/5 px-4 py-2.5 text-left hover:bg-white/10"
                      >
                        {c.label || `카메라 ${i + 1}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button
                onClick={() => connect()}
                className="flex items-center gap-2 rounded-lg bg-sky-500 px-5 py-2.5 font-semibold text-white hover:bg-sky-400"
              >
                <RefreshCw size={18} /> 다시 연결
              </button>
            </div>
          </div>
        )}

        {/* 상태 표시 */}
        <div className="pointer-events-none absolute left-4 top-4 z-10 flex flex-wrap gap-2">
          {frozen && (
            <span className="rounded-full bg-red-600 px-3 py-1 text-sm font-bold shadow">⏸ 멈춤 (Space로 재생)</span>
          )}
          {showUi && status === "live" && Math.abs(view.zoom - 1) > 0.01 && (
            <span className="rounded-full bg-black/60 px-3 py-1 text-sm">{Math.round(view.zoom * 100)}%</span>
          )}
        </div>

        {flash > 0 && <div key={flash} className="flash pointer-events-none absolute inset-0 bg-white" />}

        {toast && (
          <div
            key={toast.key}
            className="toast pointer-events-none absolute left-1/2 top-5 z-30 -translate-x-1/2 rounded-full bg-black/80 px-5 py-2.5 text-base font-medium shadow-lg ring-1 ring-white/10"
          >
            {toast.msg}
          </div>
        )}

        <RecordBadge r={recorder} />

        {/* 도구막대 */}
        <div
          className={`absolute inset-x-0 bottom-4 z-20 flex justify-center px-3 transition-opacity duration-300 ${
            showUi ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerEnter={() => (barHover.current = true)}
          onPointerLeave={() => (barHover.current = false)}
        >
          <div className="relative flex max-w-full flex-wrap items-center justify-center gap-1 rounded-2xl bg-neutral-900/90 p-1.5 shadow-2xl ring-1 ring-white/10 backdrop-blur">
            <label className="flex items-center gap-1.5 rounded-xl px-2 py-1.5 hover:bg-white/10" title="카메라 선택 (N: 다음 카메라)">
              <Camera size={18} className="shrink-0 text-white/70" />
              <select
                value={camId}
                onChange={(e) => {
                  selectCam(e.target.value);
                  e.currentTarget.blur();
                }}
                className="max-w-40 cursor-pointer truncate bg-transparent text-sm outline-none"
              >
                {!curCam && <option value="">{status === "connecting" ? "연결 중…" : "카메라 없음"}</option>}
                {cams.map((c, i) => (
                  <option key={c.deviceId || i} value={c.deviceId} className="bg-neutral-900">
                    {c.label || `카메라 ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>

            <Sep />
            <Btn label="이동" keys="V" active={tool === "move"} onClick={() => pickTool("move")}>
              <Hand size={20} />
            </Btn>
            <Btn label="펜" keys="P" active={tool === "pen"} onClick={() => pickTool("pen")}>
              <Pen size={20} />
            </Btn>
            <Btn label="형광펜" keys="H" active={tool === "highlighter"} onClick={() => pickTool("highlighter")}>
              <Highlighter size={20} />
            </Btn>
            <Btn label="지우개" keys="E" active={tool === "eraser"} onClick={() => pickTool("eraser")}>
              <Eraser size={20} />
            </Btn>
            <Btn label="글자 메모" keys="T" active={tool === "text"} onClick={() => pickTool("text")}>
              <Type size={20} />
            </Btn>
            {(tool === "pen" || tool === "highlighter" || tool === "text") && (
              <div className="flex items-center gap-1 px-1">
                {COLORS.map((c, i) => (
                  <button
                    key={c}
                    title={`${COLOR_NAMES[i]} (${i + 1})`}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => setColor(c)}
                    className={`h-5 w-5 rounded-full ring-2 ${color === c ? "ring-white" : "ring-white/15"}`}
                    style={{ background: c }}
                  />
                ))}
                {tool !== "text" &&
                  (["s", "m", "l"] as const).map((s) => (
                    <button
                      key={s}
                      title={{ s: "가늘게", m: "보통", l: "굵게" }[s]}
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => setPenSize(s)}
                      className={`grid h-7 w-7 place-items-center rounded-lg ${penSize === s ? "bg-white/20" : "hover:bg-white/10"}`}
                    >
                      <span className="rounded-full bg-white" style={{ width: PEN_PX[s] + 2, height: PEN_PX[s] + 2 }} />
                    </button>
                  ))}
              </div>
            )}
            <Btn label="되돌리기" keys="Ctrl+Z" disabled={!hist.past.length} onClick={undo}>
              <Undo2 size={20} />
            </Btn>
            <Btn label="다시 하기" keys="Ctrl+Y" disabled={!hist.future.length} onClick={redo}>
              <Redo2 size={20} />
            </Btn>
            <Btn label="판서 모두 지우기" keys="X" disabled={!hist.cur.length} onClick={clearAnno}>
              <Trash2 size={20} />
            </Btn>

            <Sep />
            <Btn label="축소" keys="-" onClick={() => zoomAt(0.8)}>
              <ZoomOut size={20} />
            </Btn>
            <button
              title="원래 크기로 (0)"
              onPointerDown={(e) => e.preventDefault()}
              onClick={resetView}
              className="min-w-14 rounded-xl px-1 py-2 text-sm tabular-nums hover:bg-white/10"
            >
              {Math.round(view.zoom * 100)}%
            </button>
            <Btn label="확대" keys="+" onClick={() => zoomAt(1.25)}>
              <ZoomIn size={20} />
            </Btn>
            <Btn label="회전" keys="R" onClick={() => rotate(1)}>
              <RotateCw size={20} />
            </Btn>
            <Btn label="좌우 반전" keys="M" active={mirror} onClick={toggleMirror}>
              <FlipHorizontal2 size={20} />
            </Btn>

            <Sep />
            <Btn label={frozen ? "다시 재생" : "화면 멈춤"} keys="Space" active={frozen} onClick={toggleFreeze}>
              {frozen ? <Play size={20} /> : <Pause size={20} />}
            </Btn>
            <button
              title="캡처 (S) · 전체 화면 캡처 (Shift+S)"
              onPointerDown={(e) => e.preventDefault()}
              onClick={(e) => capture(e.shiftKey ? "full" : "view")}
              className="flex items-center gap-1.5 rounded-xl bg-sky-500 px-3.5 py-2 font-semibold hover:bg-sky-400"
            >
              <Camera size={20} /> 캡처
            </button>
            {recorder.rec ? (
              <Btn label="녹화 끝내기" keys="O" onClick={recorder.stop}>
                <span className="h-4 w-4 animate-pulse rounded-sm bg-red-500" />
              </Btn>
            ) : (
              <Btn
                label="화면 녹화"
                keys="O"
                active={recorder.panelOpen}
                onClick={() => {
                  setSettingsOpen(false);
                  recorder.setPanelOpen((o) => !o);
                }}
              >
                <Circle size={18} className="text-red-500" fill="currentColor" />
              </Btn>
            )}
            <Btn label="캡처 목록" keys="G" active={galleryOpen} onClick={() => setGalleryOpen((g) => !g)}>
              <span className="relative">
                <Images size={20} />
                {captures.length > 0 && (
                  <span className="absolute -right-2.5 -top-2 min-w-4 rounded-full bg-sky-500 px-1 text-[10px] leading-4 font-bold">
                    {captures.length}
                  </span>
                )}
              </span>
            </Btn>

            <Sep />
            <Btn label={fullscreen ? "전체 화면 끝내기" : "전체 화면"} keys="F" onClick={toggleFullscreen}>
              {fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
            </Btn>
            <Btn label="설정" keys="" active={settingsOpen} onClick={() => {
                recorder.setPanelOpen(false);
                setSettingsOpen((s) => !s);
              }}>
              <SlidersHorizontal size={20} />
            </Btn>
            <Btn label="단축키" keys="?" onClick={() => setHelpOpen(true)}>
              <Keyboard size={20} />
            </Btn>

            {recorder.panelOpen && <RecordPanel r={recorder} />}
            {settingsOpen && (
              <div className="absolute bottom-full right-0 mb-2 w-72 rounded-2xl bg-neutral-900 p-4 text-sm shadow-2xl ring-1 ring-white/10">
                <div className="mb-3 flex items-center justify-between">
                  <span className="font-bold">설정</span>
                  <button onClick={() => setSettingsOpen(false)} className="text-white/60 hover:text-white">
                    <X size={18} />
                  </button>
                </div>
                <label className="mb-3 block">
                  <div className="mb-1 text-white/60">화질</div>
                  <select
                    value={quality}
                    onChange={(e) => {
                      const q = e.target.value as Quality;
                      setQuality(q);
                      lsSet(LS_QUALITY, q);
                      L.current.quality = q;
                      connect(camId || undefined);
                      e.currentTarget.blur();
                    }}
                    className="w-full rounded-lg bg-white/10 px-2 py-1.5 outline-none"
                  >
                    {(Object.keys(QUALITY_LABEL) as Quality[]).map((q) => (
                      <option key={q} value={q} className="bg-neutral-900">
                        {QUALITY_LABEL[q]}
                      </option>
                    ))}
                  </select>
                  {trackInfo && <div className="mt-1 text-xs text-white/40">지금: {trackInfo}</div>}
                </label>
                <Slider label="밝기" hint="[ ]" value={bright} onChange={setBright} />
                <Slider label="대비" value={contrast} onChange={setContrast} />
                <label className="mb-3 flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={captureAnno} onChange={(e) => setCaptureAnno(e.target.checked)} />
                  캡처할 때 판서도 함께 담기
                </label>
                <button
                  onClick={() => {
                    setBright(1);
                    setContrast(1);
                    setRot(0);
                    setMirror(false);
                    resetView();
                  }}
                  className="w-full rounded-lg bg-white/10 py-2 hover:bg-white/15"
                >
                  화면 설정 모두 초기화
                </button>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* 캡처 목록 */}
      {galleryOpen && (
        <aside className="flex w-64 shrink-0 flex-col border-l border-white/10 bg-neutral-900">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2.5">
            <div className="flex rounded-lg bg-white/5 p-0.5 text-sm">
              {(["photo", "video"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setGalleryTab(t)}
                  className={`rounded-md px-3 py-1 ${galleryTab === t ? "bg-white/15 font-bold" : "text-white/60 hover:text-white"}`}
                >
                  {t === "photo" ? `사진 ${captures.length}` : `영상 ${recordings.length}`}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {galleryTab === "photo" && captures.length > 0 && (
                <button onClick={removeAllCaptures} className="rounded-lg px-2 py-1 text-xs text-white/60 hover:bg-white/10 hover:text-white">
                  모두 지우기
                </button>
              )}
              <button title="닫기 (G)" onClick={() => setGalleryOpen(false)} className="rounded-lg p-1 text-white/60 hover:bg-white/10 hover:text-white">
                <X size={18} />
              </button>
            </div>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-3">
            {galleryTab === "photo" && captures.length === 0 && (
              <p className="px-1 py-6 text-center text-sm leading-relaxed text-white/50">
                아직 캡처가 없어요.
                <br />
                <kbd className="rounded bg-white/10 px-1.5">S</kbd> 를 누르면 지금 화면이 여기에 쌓여요.
              </p>
            )}
            {galleryTab === "photo" &&
              captures.map((c, i) => (
                <div key={c.id} className="group relative overflow-hidden rounded-lg bg-black ring-1 ring-white/10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={c.url} alt={`캡처 ${captures.length - i}`} className="aspect-video w-full cursor-zoom-in object-contain" onClick={() => setViewing(c.id)} />
                  <div className="flex items-center justify-between px-2 py-1 text-xs text-white/60">
                    <span>
                      #{captures.length - i} · {new Date(c.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className="flex gap-0.5 opacity-70 group-hover:opacity-100">
                      <MiniBtn title="저장" onClick={() => downloadCapture(c)}>
                        <Download size={14} />
                      </MiniBtn>
                      <MiniBtn title="복사" onClick={() => copyCapture(c)}>
                        <Copy size={14} />
                      </MiniBtn>
                      <MiniBtn title="삭제" onClick={() => removeCapture(c.id)}>
                        <Trash2 size={14} />
                      </MiniBtn>
                    </span>
                  </div>
                </div>
              ))}
            {galleryTab === "video" && recordings.length === 0 && (
              <p className="px-1 py-6 text-center text-sm leading-relaxed text-white/50">
                아직 녹화한 영상이 없어요.
                <br />
                <kbd className="rounded bg-white/10 px-1.5">O</kbd> 를 누르면 녹화를 시작할 수 있어요.
              </p>
            )}
            {galleryTab === "video" &&
              recordings.map((r) => (
                <div key={r.id} className="group relative overflow-hidden rounded-lg bg-black ring-1 ring-white/10">
                  <button className="relative block w-full" onClick={() => setPlaying(r.id)}>
                    <video src={`${r.url}#t=0.5`} preload="metadata" muted className="pointer-events-none aspect-video w-full object-contain" />
                    <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1.5 text-xs tabular-nums">{formatDuration(r.durationMs)}</span>
                    <span className="absolute inset-0 grid place-items-center opacity-0 transition group-hover:opacity-100">
                      <Play size={32} className="drop-shadow" fill="currentColor" />
                    </span>
                  </button>
                  <div className="flex items-center justify-between px-2 py-1 text-xs text-white/60">
                    <span>
                      {new Date(r.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} · {(r.blob.size / 1048576).toFixed(1)}MB
                    </span>
                    <span className="flex gap-0.5 opacity-70 group-hover:opacity-100">
                      <MiniBtn title="저장" onClick={() => downloadRecording(r)}>
                        <Download size={14} />
                      </MiniBtn>
                      <MiniBtn title="삭제" onClick={() => removeRecording(r.id)}>
                        <Trash2 size={14} />
                      </MiniBtn>
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </aside>
      )}

      {/* 녹화 영상 보기 */}
      {playingRec && (
        <div className="fixed inset-0 z-40 flex flex-col bg-black/95" onClick={() => setPlaying(null)}>
          <div className="flex items-center justify-between px-5 py-3" onClick={(e) => e.stopPropagation()}>
            <span className="flex items-center gap-2 text-white/70">
              <Video size={18} />
              녹화 · {new Date(playingRec.createdAt).toLocaleTimeString("ko-KR")} · {formatDuration(playingRec.durationMs)} ·{" "}
              {(playingRec.blob.size / 1048576).toFixed(1)}MB
              <span className="ml-2 text-xs text-white/40">Space 재생/멈춤 · Esc 닫기</span>
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => downloadRecording(playingRec)}
                className="flex items-center gap-1.5 rounded-xl bg-sky-500 px-3.5 py-2 font-semibold hover:bg-sky-400"
                title="파일로 저장 (Ctrl+S)"
              >
                <Download size={18} /> 저장 (.{playingRec.ext})
              </button>
              <Btn label="삭제" keys="Delete" onClick={() => removeRecording(playingRec.id)}>
                <Trash2 size={20} />
              </Btn>
              <Btn label="닫기" keys="Esc" onClick={() => setPlaying(null)}>
                <X size={20} />
              </Btn>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
            <video ref={playerRef} key={playingRec.id} src={playingRec.url} controls autoPlay className="max-h-full max-w-full" />
          </div>
        </div>
      )}

      {/* 캡처 크게 보기 */}
      {viewingCap && (
        <div className="fixed inset-0 z-40 flex flex-col bg-black/95" onClick={() => setViewing(null)}>
          <div className="flex items-center justify-between px-5 py-3" onClick={(e) => e.stopPropagation()}>
            <span className="text-white/70">
              캡처 #{captures.length - viewingIdx} ·{" "}
              {new Date(viewingCap.createdAt).toLocaleTimeString("ko-KR")}
              <span className="ml-3 text-xs text-white/40">← → 넘기기 · Esc 닫기 · Delete 삭제</span>
            </span>
            <div className="flex gap-1">
              <Btn label="저장" keys="Ctrl+S" onClick={() => downloadCapture(viewingCap)}>
                <Download size={20} />
              </Btn>
              <Btn label="복사" keys="Ctrl+C" onClick={() => copyCapture(viewingCap)}>
                <Copy size={20} />
              </Btn>
              <Btn label="삭제" keys="Delete" onClick={deleteViewing}>
                <Trash2 size={20} />
              </Btn>
              <Btn label="닫기" keys="Esc" onClick={() => setViewing(null)}>
                <X size={20} />
              </Btn>
            </div>
          </div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={viewingCap.url} alt="캡처 크게 보기" className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
            {viewingIdx > 0 && (
              <button
                className="absolute left-4 rounded-full bg-white/10 p-3 hover:bg-white/20"
                onClick={(e) => {
                  e.stopPropagation();
                  moveViewing(-1);
                }}
              >
                <ChevronLeft />
              </button>
            )}
            {viewingIdx < captures.length - 1 && (
              <button
                className="absolute right-4 rounded-full bg-white/10 p-3 hover:bg-white/20"
                onClick={(e) => {
                  e.stopPropagation();
                  moveViewing(1);
                }}
              >
                <ChevronRight />
              </button>
            )}
          </div>
        </div>
      )}

      {/* 단축키 도움말 */}
      {helpOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={() => setHelpOpen(false)}>
          <div
            className="max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl bg-neutral-900 p-6 shadow-2xl ring-1 ring-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold">단축키</h2>
              <button onClick={() => setHelpOpen(false)} className="text-white/60 hover:text-white">
                <X />
              </button>
            </div>
            <p className="mb-5 text-sm text-white/50">한글 입력 상태에서도 그대로 동작해요. Mac에서는 Ctrl 대신 ⌘도 돼요.</p>
            <div className="grid gap-6 sm:grid-cols-2">
              {SHORTCUT_GROUPS.map((g) => (
                <section key={g.title}>
                  <h3 className="mb-2 font-semibold text-sky-300">{g.title}</h3>
                  <ul className="space-y-1.5 text-sm">
                    {g.items.map(([k, d]) => (
                      <li key={k} className="flex items-center justify-between gap-3">
                        <span className="text-white/80">{d}</span>
                        <kbd className="shrink-0 rounded-md bg-white/10 px-2 py-0.5 font-mono text-xs">{k}</kbd>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Btn({
  label,
  keys,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  keys: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={keys ? `${label} (${keys})` : label}
      aria-label={label}
      disabled={disabled}
      // 버튼이 포커스를 가져가면 Space가 버튼 클릭이 되어 버리므로 막는다
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`grid h-9 w-9 place-items-center rounded-xl transition-colors disabled:opacity-30 ${
        active ? "bg-white text-neutral-900" : "hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

function MiniBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick} className="rounded p-1 hover:bg-white/15 hover:text-white">
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-6 w-px bg-white/15" />;
}

function Slider({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="mb-3 block">
      <div className="mb-1 flex justify-between text-white/60">
        <span>
          {label} {hint && <kbd className="ml-1 rounded bg-white/10 px-1 text-xs">{hint}</kbd>}
        </span>
        <span className="tabular-nums">{Math.round(value * 100)}%</span>
      </div>
      <input
        type="range"
        min={0.3}
        max={2}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => e.currentTarget.blur()}
        className="w-full accent-sky-400"
      />
    </label>
  );
}
