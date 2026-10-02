import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "웹 실물화상기",
  description: "프로그램 설치 없이 브라우저에서 바로 쓰는 실물화상기 — 확대·회전·캡처·판서",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full bg-neutral-950 antialiased">
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
