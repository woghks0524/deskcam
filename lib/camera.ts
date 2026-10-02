export type Quality = "720" | "1080" | "4k";

export const QUALITY_SIZE: Record<Quality, [number, number]> = {
  "720": [1280, 720],
  "1080": [1920, 1080],
  "4k": [3840, 2160],
};

export const QUALITY_LABEL: Record<Quality, string> = {
  "720": "보통 (720p)",
  "1080": "선명 (1080p)",
  "4k": "최고 (4K)",
};

// 노트북 내장 카메라는 실물화상기가 아니므로 뒤로 미룬다
const BUILTIN = /facetime|integrated|built-?in|내장|front|rear|back camera|ir camera|user.?facing|hd webcam/i;
const VIRTUAL = /virtual|obs|snap camera|manycam|xsplit|broadcast|camo|continuity|iphone|ipad/i;
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

export async function listCameras() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "videoinput");
}

export async function openCamera(deviceId: string | undefined, quality: Quality) {
  const [width, height] = QUALITY_SIZE[quality];
  const base: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : {};
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...base, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
    });
  } catch (err) {
    // 해상도 조건 때문에 실패하면 조건 없이 한 번 더
    if (err instanceof DOMException && err.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: deviceId ? base : true });
    }
    throw err;
  }
}

export function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "카메라 권한이 막혀 있어요. 주소창 왼쪽 아이콘을 눌러 카메라를 '허용'으로 바꾼 뒤 [다시 연결]을 눌러 주세요.";
    case "NotReadableError":
    case "AbortError":
      return "다른 프로그램이 카메라를 쓰고 있어요. 기존 실물화상기 프로그램이나 줌·팀즈를 끄고 [다시 연결]을 눌러 주세요.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "연결된 카메라를 찾지 못했어요. USB를 꽂으면 자동으로 연결돼요.";
    default:
      return "카메라를 여는 중에 문제가 생겼어요. USB를 다시 꽂고 [다시 연결]을 눌러 주세요.";
  }
}
