"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Circle, Monitor, Pause, Play, Square, X } from "lucide-react";
import { canRecordScreen, pickMime, startRecording, type RecOptions, type RecSession, type RecSource } from "@/lib/recorder";

const LS_MIC = "doccam.mic";
const LS_SYS = "doccam.systemAudio";

export type NewRecording = { createdAt: number; blob: Blob; ext: string; durationMs: number };

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h ? `${h}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

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

export function useRecorder({
  paint,
  getCameraSize,
  notify,
  onSaved,
}: {
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  getCameraSize: () => { width: number; height: number };
  notify: (msg: string) => void;
  onSaved: (r: NewRecording) => void;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [opts, setOpts] = useState<RecOptions>(() => {
    const mic = lsGet(LS_MIC);
    return { source: "camera", micId: mic === "none" ? null : (mic ?? ""), systemAudio: lsGet(LS_SYS) !== "0" };
  });
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [rec, setRec] = useState<{ source: RecSource; paused: boolean; hasAudio: boolean } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const session = useRef<RecSession | null>(null);
  const timing = useRef({ startedAt: 0, pausedTotal: 0, pausedAt: 0 });
  const busy = useRef(false);

  const elapsedNow = () => {
    const t = timing.current;
    return (t.pausedAt || Date.now()) - t.startedAt - t.pausedTotal;
  };

  useEffect(() => {
    if (!panelOpen) return;
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => setMics(all.filter((d) => d.kind === "audioinput" && !["default", "communications"].includes(d.deviceId))))
      .catch(() => {});
  }, [panelOpen]);

  useEffect(() => {
    if (!rec) return;
    const id = setInterval(() => {
      setElapsed(elapsedNow());
      setLevel(session.current?.level() ?? 0);
    }, 150);
    return () => clearInterval(id);
  }, [rec]);

  useEffect(() => () => session.current?.stop(), []);

  const start = useCallback(async () => {
    if (busy.current || session.current) return;
    busy.current = true;
    setPanelOpen(false);
    lsSet(LS_MIC, opts.micId === null ? "none" : opts.micId);
    lsSet(LS_SYS, opts.systemAudio ? "1" : "0");
    try {
      const { width, height } = getCameraSize();
      const s = await startRecording(
        opts,
        { width, height, paint },
        {
          onWarn: notify,
          onDone: (blob, ext) => {
            const durationMs = elapsedNow();
            session.current = null;
            setRec(null);
            setElapsed(0);
            if (!blob.size) return notify("녹화된 내용이 없어요");
            onSaved({ createdAt: Date.now(), blob, ext, durationMs });
          },
        },
      );
      session.current = s;
      timing.current = { startedAt: Date.now(), pausedTotal: 0, pausedAt: 0 };
      setElapsed(0);
      setRec({ source: opts.source, paused: false, hasAudio: s.hasAudio });
      notify(`${opts.source === "camera" ? "실물화상기 화면" : "컴퓨터 화면"} 녹화를 시작했어요 · O로 끝내기`);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      notify(name === "NotAllowedError" ? "녹화를 취소했어요" : "녹화를 시작하지 못했어요");
    } finally {
      busy.current = false;
    }
  }, [opts, getCameraSize, paint, notify, onSaved]);

  const stop = useCallback(() => session.current?.stop(), []);

  const togglePause = useCallback(() => {
    const s = session.current;
    if (!s) return;
    const t = timing.current;
    setRec((r) => {
      if (!r) return r;
      if (r.paused) {
        t.pausedTotal += Date.now() - t.pausedAt;
        t.pausedAt = 0;
        s.resume();
      } else {
        t.pausedAt = Date.now();
        s.pause();
      }
      return { ...r, paused: !r.paused };
    });
  }, []);

  return { panelOpen, setPanelOpen, opts, setOpts, mics, rec, elapsed, level, start, stop, togglePause };
}

export type RecorderApi = ReturnType<typeof useRecorder>;

export function RecordPanel({ r }: { r: RecorderApi }) {
  const { opts, setOpts, mics } = r;
  const supported = !!pickMime();
  const screenOk = canRecordScreen();
  return (
    <div className="absolute bottom-full right-0 mb-2 w-80 rounded-2xl bg-neutral-900 p-4 text-sm shadow-2xl ring-1 ring-white/10">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-bold">화면 녹화</span>
        <button onClick={() => r.setPanelOpen(false)} className="text-white/60 hover:text-white">
          <X size={18} />
        </button>
      </div>
      {!supported ? (
        <p className="text-white/70">이 브라우저는 녹화를 지원하지 않아요. 크롬이나 엣지를 써 주세요.</p>
      ) : (
        <>
          <div className="mb-1 text-white/60">무엇을 녹화할까요?</div>
          <div className="mb-4 grid grid-cols-2 gap-2">
            <SourceCard
              active={opts.source === "camera"}
              onClick={() => setOpts({ ...opts, source: "camera" })}
              icon={<Camera size={22} />}
              title="실물화상기 화면"
              desc="확대·판서까지 보이는 그대로"
            />
            <SourceCard
              active={opts.source === "screen"}
              disabled={!screenOk}
              onClick={() => setOpts({ ...opts, source: "screen" })}
              icon={<Monitor size={22} />}
              title="컴퓨터 화면"
              desc="인터넷 탭·프로그램 창·전체 화면"
            />
          </div>

          <label className="mb-3 block">
            <div className="mb-1 text-white/60">마이크</div>
            <select
              value={opts.micId === null ? "none" : opts.micId}
              onChange={(e) => {
                setOpts({ ...opts, micId: e.target.value === "none" ? null : e.target.value });
                e.currentTarget.blur();
              }}
              className="w-full rounded-lg bg-white/10 px-2 py-1.5 outline-none"
            >
              <option value="none" className="bg-neutral-900">
                마이크 끄기
              </option>
              <option value="" className="bg-neutral-900">
                기본 마이크
              </option>
              {mics
                .filter((m) => m.label)
                .map((m) => (
                  <option key={m.deviceId} value={m.deviceId} className="bg-neutral-900">
                    {m.label}
                  </option>
                ))}
            </select>
          </label>

          {opts.source === "screen" && (
            <label className="mb-3 flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={opts.systemAudio}
                onChange={(e) => setOpts({ ...opts, systemAudio: e.target.checked })}
              />
              <span>
                컴퓨터 소리도 함께
                <span className="mt-0.5 block text-xs leading-relaxed text-white/45">
                  고르는 창에서 &lsquo;오디오 공유&rsquo;를 켜 주세요. 맥은 크롬 탭 소리만, 윈도우는 전체 화면 소리도 돼요.
                </span>
              </span>
            </label>
          )}

          <button
            onClick={r.start}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 py-2.5 font-semibold hover:bg-red-500"
          >
            <Circle size={14} fill="currentColor" /> 녹화 시작
          </button>
          <p className="mt-2 text-xs leading-relaxed text-white/45">
            {opts.source === "screen"
              ? "시작하면 녹화할 화면을 고르는 창이 떠요. 다른 창을 보고 있어도 계속 녹화돼요."
              : "다른 탭으로 옮겨도 계속 녹화돼요. 끝난 영상은 캡처 목록 > 영상에 쌓여요."}
          </p>
        </>
      )}
    </div>
  );
}

function SourceCard({
  active,
  disabled,
  onClick,
  icon,
  title,
  desc,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`flex flex-col items-start gap-1 rounded-xl p-3 text-left ring-1 transition disabled:opacity-30 ${
        active ? "bg-red-600/20 ring-red-500" : "bg-white/5 ring-white/10 hover:bg-white/10"
      }`}
    >
      {icon}
      <span className="font-semibold">{title}</span>
      <span className="text-xs leading-snug text-white/55">{desc}</span>
    </button>
  );
}

export function RecordBadge({ r }: { r: RecorderApi }) {
  if (!r.rec) return null;
  const { paused, hasAudio, source } = r.rec;
  return (
    <div
      className="absolute right-4 top-4 z-30 flex items-center gap-2 rounded-full bg-black/80 py-1.5 pl-3 pr-1.5 shadow-lg ring-1 ring-red-500/60"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className={`h-2.5 w-2.5 rounded-full bg-red-500 ${paused ? "" : "animate-pulse"}`} />
      <span className="text-sm font-semibold tabular-nums">
        {paused ? "일시정지" : source === "camera" ? "녹화" : "화면 녹화"} {formatDuration(r.elapsed)}
      </span>
      {hasAudio && (
        <span className="h-1.5 w-12 overflow-hidden rounded-full bg-white/15" title="소리 크기">
          <span className="block h-full bg-green-400 transition-[width]" style={{ width: `${Math.round(r.level * 100)}%` }} />
        </span>
      )}
      <button
        title={paused ? "이어서 녹화" : "일시정지"}
        onPointerDown={(e) => e.preventDefault()}
        onClick={r.togglePause}
        className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15"
      >
        {paused ? <Play size={16} /> : <Pause size={16} />}
      </button>
      <button
        title="녹화 끝내기 (O)"
        onPointerDown={(e) => e.preventDefault()}
        onClick={r.stop}
        className="flex h-8 items-center gap-1 rounded-full bg-red-600 px-3 text-sm font-semibold hover:bg-red-500"
      >
        <Square size={12} fill="currentColor" /> 끝내기
      </button>
    </div>
  );
}
