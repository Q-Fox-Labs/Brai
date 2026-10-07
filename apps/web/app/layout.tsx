// ABOUTME: Задаёт общий HTML каркас веб-приложения Brai.
// ABOUTME: Не содержит прикладной логики и внешних подключений.
import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { ReactNode } from "react";
import { AppStartupBoundary } from "./shell/app-startup-boundary";
import "./globals.css";

const themeBootstrap = `(function(){window.__braiStartupStartedAt=performance.now();var root=document.documentElement;var mode="system";try{var savedMode=localStorage.getItem("brai_theme_mode");if(savedMode==="light"||savedMode==="dark")mode=savedMode;}catch(error){}var dark=mode==="dark"||(mode==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);root.dataset.theme=dark?"dark":"light";root.dataset.themeMode=mode;root.classList.toggle("dark",dark);})();`;

export const metadata: Metadata = {
  title: "Brai DEV",
  description: "Приватное приложение Brai",
  applicationName: "Brai",
  appleWebApp: {
    capable: true,
    title: "Brai",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icons/dev/favicon.png", sizes: "64x64", type: "image/png", media: "(prefers-color-scheme: light)" },
      { url: "/icons/dev/favicon-dark.png", sizes: "64x64", type: "image/png", media: "(prefers-color-scheme: dark)" },
    ],
    shortcut: "/icons/dev/favicon.png",
    apple: [{ url: "/icons/Icon-192.png", sizes: "192x192", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",
};

/** Настраивает базовые метаданные viewport и цвета оформления браузера для каждой темы. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f3" },
    { media: "(prefers-color-scheme: dark)", color: "#050607" },
  ],
};

/** Отображает корневую разметку маршрутов приложения. */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ru" data-theme="light" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body><AppStartupBoundary>{children}</AppStartupBoundary></body>
    </html>
  );
}
