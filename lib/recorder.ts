// 화면 녹화: 실물화상기 화면(캔버스로 그대로 그림) 또는 컴퓨터 화면(getDisplayMedia)을
// 마이크·컴퓨터 소리와 섞어서 MediaRecorder로 저장한다.

export type RecSource = "camera" | "screen";

export type RecOptions = {
  source: RecSource;
  micId: string | null; // null = 마이크 끔, "" = 기본 마이크
  systemAudio: boolean; // 컴퓨터 화면 녹화일 때만 의미 있음
};

export type RecSession = {
  pause(): void;
  resume(): void;
  stop(): void;
  level(): number; // 0~1 소리 크기 (마이크 확인용)
  hasAudio: boolean;
};

// avc3: 녹화 중 창 크기가 바뀌어도(컴퓨터 화면 녹화) 끊기지 않는 H.264 방식
const MIME_CANDIDATES: [string, string][] = [
  ["video/mp4;codecs=avc3.640028,mp4a.40.2", "mp4"],
  ["video/mp4;codecs=avc3.42E01E,mp4a.40.2", "mp4"],
  ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "mp4"],
  ["video/mp4;codecs=avc1,mp4a.40.2", "mp4"],
  ["video/mp4", "mp4"],
  ["video/webm;codecs=vp9,opus", "webm"],
  ["video/webm;codecs=vp8,opus", "webm"],
  ["video/webm", "webm"],
];

// mp4가 되면 mp4로(PPT·카톡 어디서나 재생됨), 안 되면 webm
export function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  const hit = MIME_CANDIDATES.find(([m]) => MediaRecorder.isTypeSupported(m));
  return hit ? { mime: hit[0], ext: hit[1] } : { mime: "", ext: "webm" };
}

export const canRecordScreen = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices && "getDisplayMedia" in navigator.mediaDevices;

// 다른 탭을 보고 있어도 녹화가 끊기지 않도록, 메인 스레드 타이머 대신 워커로 박자를 맞춘다
function createTicker(fps: number, cb: () => void) {
  try {
    const src = `const t=setInterval(()=>postMessage(0),${Math.round(1000 / fps)});`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url);
    w.onmessage = cb;
    return () => {
      w.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = setInterval(cb, 1000 / fps);
    return () => clearInterval(id);
  }
}

export async function startRecording(
  opts: RecOptions,
  camera: { width: number; height: number; paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void },
  handlers: { onDone: (blob: Blob, ext: string) => void; onWarn: (msg: string) => void },
): Promise<RecSession> {
  const cleanups: (() => void)[] = [];
  const cleanup = () => cleanups.splice(0).reverse().forEach((f) => f());

  try {
    let videoTrack: MediaStreamTrack;
    let systemTrack: MediaStreamTrack | undefined;

    if (opts.source === "screen") {
      const ds = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: opts.systemAudio,
        // 크롬 전용 옵션: 이 탭도 고를 수 있게, 시스템 소리 체크박스 보이게
        selfBrowserSurface: "include",
        surfaceSwitching: "include",
        systemAudio: opts.systemAudio ? "include" : "exclude",
      } as DisplayMediaStreamOptions);
      cleanups.push(() => ds.getTracks().forEach((t) => t.stop()));
      videoTrack = ds.getVideoTracks()[0];
      systemTrack = ds.getAudioTracks()[0];
      if (opts.systemAudio && !systemTrack) {
        handlers.onWarn("컴퓨터 소리는 빠졌어요 (공유 창에서 '오디오 공유'가 꺼져 있었어요)");
      }
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = camera.width;
      canvas.height = camera.height;
      const ctx = canvas.getContext("2d")!;
      const paint = () => camera.paint(ctx, canvas.width, canvas.height);
      paint();
      const cs = canvas.captureStream(30);
      videoTrack = cs.getVideoTracks()[0];
      cleanups.push(createTicker(30, paint), () => videoTrack.stop());
    }

    let micTrack: MediaStreamTrack | undefined;
    if (opts.micId !== null) {
      try {
        const ms = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: opts.micId ? { exact: opts.micId } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        micTrack = ms.getAudioTracks()[0];
        cleanups.push(() => ms.getTracks().forEach((t) => t.stop()));
      } catch {
        handlers.onWarn("마이크를 열지 못해서 소리 없이 녹화해요");
      }
    }

    // 마이크와 컴퓨터 소리를 하나로 섞고, 소리 크기도 잰다
    let audioTrack: MediaStreamTrack | undefined;
    let analyser: AnalyserNode | undefined;
    const sources = [micTrack, systemTrack].filter((t): t is MediaStreamTrack => !!t);
    if (sources.length) {
      const ac = new AudioContext();
      const dest = ac.createMediaStreamDestination();
      analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      for (const t of sources) {
        const src = ac.createMediaStreamSource(new MediaStream([t]));
        src.connect(dest);
        src.connect(analyser);
      }
      audioTrack = dest.stream.getAudioTracks()[0];
      cleanups.push(() => ac.close().catch(() => {}));
    }

    const picked = pickMime() ?? { mime: "", ext: "webm" };
    const stream = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);
    const rec = new MediaRecorder(stream, {
      mimeType: picked.mime || undefined,
      videoBitsPerSecond: opts.source === "screen" ? 6_000_000 : 5_000_000,
      audioBitsPerSecond: 128_000,
    });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      cleanup();
      const type = (rec.mimeType || picked.mime || "video/webm").split(";")[0];
      handlers.onDone(new Blob(chunks, { type }), type.includes("mp4") ? "mp4" : "webm");
    };
    // 브라우저의 '공유 중지' 버튼을 누르면 녹화도 끝낸다
    videoTrack.addEventListener("ended", () => rec.state !== "inactive" && rec.stop());
    rec.start(1000);

    const buf = analyser ? new Uint8Array(analyser.fftSize) : null;
    return {
      pause: () => rec.state === "recording" && rec.pause(),
      resume: () => rec.state === "paused" && rec.resume(),
      stop: () => rec.state !== "inactive" && rec.stop(),
      level: () => {
        if (!analyser || !buf) return 0;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        return Math.min(1, Math.sqrt(sum / buf.length) * 4);
      },
      hasAudio: !!audioTrack,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}
