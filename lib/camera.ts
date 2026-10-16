export type Quality = "max" | "1080" | "720";

// max: 실물화상기는 센서가 500만~800만 화소(4:3)인 경우가 많은데, 1080p로 열면
// 카메라가 줄여서 보내 확대할수록 흐려진다. 제조사 프로그램처럼 가장 큰 해상도로 연다.
export const QUALITY_SIZE: Record<Quality, [number, number]> = {
  max: [4096, 3072],
  "1080": [1920, 1080],
  "720": [1280, 720],
};

export const QUALITY_LABEL: Record<Quality, string> = {
  max: "최고 (카메라 최대 해상도)",
  "1080": "보통 (1080p)",
  "720": "가볍게 (720p)",
};

export const normalizeQuality = (q: string | null): Quality => (q === "1080" || q === "720" ? q : "max");

// 노트북 내장 카메라는 실물화상기가 아니므로 뒤로 미룬다
const BUILTIN = /facetime|integrated|built-?in|내장|front|rear|back camera|ir camera|user.?facing|hd webcam/i;
const VIRTUAL = /virtual|obs|snap camera|manycam|xsplit|broadcast|camo|continuity|iphone|ipad|desk ?view|데스크/i;
const DOCCAM = /document|visuali[sz]er|doc.?cam|실물|ipevo|elmo|hovercam|okio|joy.?cam|presenter|camcam|vz-|v4k|do-cam/i;

export function scoreCamera(label: string): number {
  if (DOCCAM.test(label)) return 10;
  if (BUILTIN.test(label)) return -10;
  if (VIRTUAL.test(label)) return -3;
  return 0; // 이름 모를 USB 카메라 = 실물화상기일 가능성이 높음
}

export type SavedCamera = { id: string; label: string };

export function pickBest(cams: MediaDeviceInfo[], saved?: SavedCamera | null) {
  if (cams.length === 0) return undefined;
  if (saved) {
    const byId = cams.find((c) => c.deviceId === saved.id);
    if (byId) return byId;
    const byLabel = saved.label && cams.find((c) => c.label === saved.label);
    if (byLabel) return byLabel;
  }
  let best = cams[0];
  let bestScore = -Infinity;
  cams.forEach((c, i) => {
    // 동점이면 나중에 꽂힌(목록 뒤쪽) 카메라를 우선
    const s = scoreCamera(c.label) + i * 0.01;
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  });
  return best;
}

// 고를 순서대로 정렬 (저장된 카메라 → 점수 높은 순, 동점이면 목록 뒤쪽 우선)
export function rankCameras(cams: MediaDeviceInfo[], saved?: SavedCamera | null) {
  const first = pickBest(cams, saved);
  const rest = cams
    .map((c, i) => ({ c, s: scoreCamera(c.label) + i * 0.01 }))
    .filter(({ c }) => c !== first)
    .sort((a, b) => b.s - a.s)
    .map(({ c }) => c);
  return first ? [first, ...rest] : rest;
}

const isPermissionError = (err: unknown) =>
  err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");

// 앞에서부터 열어 보고, 안 열리는 카메라(아이폰 연속성 카메라 등)는 건너뛴다
export async function openFirstWorking(ids: string[], quality: Quality) {
  let firstErr: unknown;
  for (const id of [...ids, undefined]) {
    try {
      return await openCamera(id, quality);
    } catch (err) {
      if (isPermissionError(err)) throw err;
      firstErr ??= err;
    }
  }
  throw firstErr;
}

// ---- 초점: 크롬이 카메라 초점 조절을 지원할 때만 (주로 Windows USB 카메라) ----
export type FocusCaps = { auto: boolean; once: boolean; range?: { min: number; max: number; step: number } };
type FocusCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
  focusDistance?: { min: number; max: number; step?: number };
};

export function getFocusCaps(track: MediaStreamTrack | undefined): FocusCaps | null {
  const caps = track?.getCapabilities?.() as FocusCapabilities | undefined;
  const modes = caps?.focusMode ?? [];
  const d = caps?.focusDistance;
  const range = d && d.max > d.min ? { min: d.min, max: d.max, step: d.step || (d.max - d.min) / 100 } : undefined;
  if (!modes.includes("continuous") && !modes.includes("single-shot") && !range) return null;
  return { auto: modes.includes("continuous"), once: modes.includes("single-shot"), range };
}

const applyFocus = (track: MediaStreamTrack, c: Record<string, unknown>) =>
  track.applyConstraints({ advanced: [c as MediaTrackConstraintSet] });

export function setAutoFocus(track: MediaStreamTrack) {
  return applyFocus(track, { focusMode: "continuous" });
}

// 지금 화면에 초점을 한 번 맞추고 그 자리에 고정한다.
// 계속 자동으로 두면 손이 화면에 들어올 때마다 초점이 왔다 갔다 해서 보기 힘들다.
export async function refocus(track: MediaStreamTrack, caps: FocusCaps) {
  if (caps.once) return applyFocus(track, { focusMode: "single-shot" });
  await applyFocus(track, { focusMode: "manual" }).catch(() => {});
  await applyFocus(track, { focusMode: "continuous" });
  await new Promise((r) => setTimeout(r, 2000));
  if (track.readyState !== "live") return;
  // 거리 없이 manual로만 바꾸면 카메라에 따라 예전에 저장된 거리로 돌아가 버린다.
  // 자동이 찾은 거리를 읽어서 그 값으로 못 박는다.
  const d = (track.getSettings() as { focusDistance?: number }).focusDistance;
  return applyFocus(track, d !== undefined ? { focusMode: "manual", focusDistance: d } : { focusMode: "manual" });
}

// ---- 카메라 자체 선명도(샤프니스): 제조사 프로그램이 주로 올려 두는 값 ----
export type RangeCap = { min: number; max: number; step: number };

export function getSharpnessCap(track: MediaStreamTrack | undefined): RangeCap | null {
  const s = (track?.getCapabilities?.() as { sharpness?: { min: number; max: number; step?: number } } | undefined)
    ?.sharpness;
  return s && s.max > s.min ? { min: s.min, max: s.max, step: s.step || 1 } : null;
}

export function setSharpness(track: MediaStreamTrack, v: number) {
  return track.applyConstraints({ advanced: [{ sharpness: v } as MediaTrackConstraintSet] });
}

export function setFocusDistance(track: MediaStreamTrack, distance: number) {
  return applyFocus(track, { focusMode: "manual", focusDistance: distance });
}

export async function listCameras() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "videoinput");
}

export async function openCamera(deviceId: string | undefined, quality: Quality) {
  const [width, height] = QUALITY_SIZE[quality];
  const base: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : {};
  const sized: MediaTrackConstraints = {
    ...base,
    width: { ideal: width },
    height: { ideal: height },
    // 최대 해상도는 15fps인 카메라가 많아서, 30fps를 원하면 브라우저가 1080p로 내려 버린다.
    // 너무 끊기는 모드(10fps 미만)만 뺀다.
    frameRate: quality === "max" ? { min: 10 } : { ideal: 30 },
  };
  const plain: MediaTrackConstraints | true = deviceId ? base : true;
  // 1) 원하는 해상도  2) 방금 끈 카메라가 아직 안 풀렸을 수 있어 잠깐 뒤 다시
  // 3) 그 해상도 모드로 못 켜는 실물화상기가 있어 조건 없이
  const tries: [number, MediaTrackConstraints | true][] = [
    [0, sized],
    [400, sized],
    [400, plain],
  ];
  let lastErr: unknown;
  for (const [wait, video] of tries) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: false, video });
    } catch (err) {
      lastErr = err;
      const name = err instanceof DOMException ? err.name : "";
      if (name === "OverconstrainedError") {
        return navigator.mediaDevices.getUserMedia({ audio: false, video: plain });
      }
      if (name !== "NotReadableError" && name !== "AbortError") throw err;
    }
  }
  throw lastErr;
}

export function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  const detail = err instanceof Error ? ` (${err.name}: ${err.message})` : "";
  return baseMessage(name) + detail;
}

function baseMessage(name: string): string {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "카메라 권한이 막혀 있어요. 주소창 왼쪽 아이콘을 눌러 카메라를 '허용'으로 바꾼 뒤 [다시 연결]을 눌러 주세요.";
    case "NotReadableError":
    case "AbortError":
      return "카메라를 켜지 못했어요. 다른 프로그램(실물화상기 프로그램·줌·팀즈)이 쓰고 있다면 끄고, 아니면 USB를 다시 꽂은 뒤 [다시 연결]을 눌러 주세요.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "연결된 카메라를 찾지 못했어요. USB를 꽂으면 자동으로 연결돼요.";
    default:
      return "카메라를 여는 중에 문제가 생겼어요. USB를 다시 꽂고 [다시 연결]을 눌러 주세요.";
  }
}
