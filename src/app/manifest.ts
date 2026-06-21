import type { MetadataRoute } from "next";

const appIcons = [
  48,
  72,
  96,
  128,
  144,
  152,
  167,
  180,
  192,
  384,
  512,
].map(size => ({
  src: `/icons/icon-${size}.png`,
  sizes: `${size}x${size}`,
  type: "image/png",
  purpose: "any" as const,
}));

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OMR Maker",
    short_name: "OMR Maker",
    description: "교사와 학생을 위한 스마트 OMR 시험 제작, 배포, 채점 앱.",
    id: "/",
    lang: "ko",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui", "browser"],
    orientation: "any",
    background_color: "#f8fafc",
    theme_color: "#f8fafc",
    categories: ["education", "productivity"],
    icons: [
      ...appIcons,
      {
        src: "/icons/maskable-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    screenshots: [
      {
        src: "/screenshots/omr-mobile-home.jpg",
        sizes: "379x844",
        type: "image/jpeg",
        form_factor: "narrow",
        label: "학생이 휴대폰에서 시험을 시작하는 OMR Maker 화면",
      },
      {
        src: "/screenshots/omr-wide-home.jpg",
        sizes: "1269x720",
        type: "image/jpeg",
        form_factor: "wide",
        label: "교사와 학생 역할을 선택하는 OMR Maker 시작 화면",
      },
    ],
    shortcuts: [
      {
        name: "시험 출제",
        short_name: "출제",
        description: "새 OMR 시험지를 만들고 편집합니다.",
        url: "/create",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "교사 대시보드",
        short_name: "대시보드",
        description: "시험과 학생 성취도를 확인합니다.",
        url: "/teacher/dashboard",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "학생 시작",
        short_name: "학생",
        description: "배정된 시험에 참여합니다.",
        url: "/?role=student",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "앱 상태 체크",
        short_name: "체크",
        description: "설치 실행 상태와 모바일 PWA 준비 상태를 확인합니다.",
        url: "/pwa-check",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
