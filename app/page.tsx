"use client";

import dynamic from "next/dynamic";

// 카메라·저장소 등 브라우저 전용 기능만 쓰므로 서버 렌더링을 하지 않는다
const DeskCam = dynamic(() => import("@/components/DeskCam"), { ssr: false });

export default function Home() {
  return <DeskCam />;
}
