export type Pt = [number, number];

export type Stroke =
  | { kind: "pen" | "highlighter" | "eraser"; color: string; size: number; points: Pt[] }
  | {
      kind: "text";
      color: string;
      size: number;
      x: number;
      y: number;
      text: string;
      // 쓸 때의 화면 회전·반전을 상쇄해서 글자가 똑바로 보이게 한다
      rot: number;
      mirror: boolean;
    };

export const TEXT_FONT = '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif';

export function renderAnnotations(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  for (const s of strokes) drawStroke(ctx, s);
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  ctx.save();
  if (s.kind === "text") {
    // 화면 변환이 반전(F)·회전(R) 순이므로 그 역(R⁻¹F)을 적용
    ctx.translate(s.x, s.y);
    ctx.rotate(-s.rot);
    ctx.scale(s.mirror ? -1 : 1, 1);
    ctx.font = `700 ${s.size}px ${TEXT_FONT}`;
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = s.size * 0.18;
    ctx.strokeStyle = s.color === "#ffffff" ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.92)";
    ctx.fillStyle = s.color;
    s.text.split("\n").forEach((line, i) => {
      const y = i * s.size * 1.25;
      ctx.strokeText(line, 0, y);
      ctx.fillText(line, 0, y);
    });
    ctx.restore();
    return;
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = s.size;
  if (s.kind === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = ctx.fillStyle = "#000";
  } else {
    if (s.kind === "highlighter") ctx.globalAlpha = 0.35;
    ctx.strokeStyle = ctx.fillStyle = s.color;
  }

  const p = s.points;
  if (p.length === 1) {
    ctx.beginPath();
    ctx.arc(p[0][0], p[0][1], s.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // 중간점을 잇는 2차 곡선으로 부드럽게
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length - 1; i++) {
      const mx = (p[i][0] + p[i + 1][0]) / 2;
      const my = (p[i][1] + p[i + 1][1]) / 2;
      ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
    }
    const last = p[p.length - 1];
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
  }
  ctx.restore();
}
