// ABOUTME: Задаёт общий HTML каркас веб-приложения Brai.
// ABOUTME: Не содержит прикладной логики и внешних подключений.
import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { ReactNode } from "react";
import { connection } from "next/server";
import { AppStartupBoundary } from "./shell/app-startup-boundary";
import { previewInfo } from "../server/preview.ts";
import "./globals.css";

const themeBootstrap = `(function(){window.__braiStartupStartedAt=performance.now();var root=document.documentElement;var mode="system";try{var savedMode=localStorage.getItem("brai_theme_mode");if(savedMode==="light"||savedMode==="dark")mode=savedMode;}catch(error){}var dark=mode==="dark"||(mode==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);root.dataset.theme=dark?"dark":"light";root.dataset.themeMode=mode;root.classList.toggle("dark",dark);})();`;
// AIDEV-NOTE: Ветка исходников не определяет контур; один release должен сохранять PROD metadata по умолчанию.
const developmentVariant = process.env.BRAI_WEB_VARIANT === "dev";
const iconRoot = developmentVariant ? "/icons/dev" : "";

export const metadata: Metadata = {
  title: developmentVariant ? "Brai DEV" : "Brai",
  description: "Приватное приложение Brai",
  applicationName: "Brai",
  appleWebApp: {
    capable: true,
    title: "Brai",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: `${iconRoot}/favicon.png`, sizes: "64x64", type: "image/png", media: "(prefers-color-scheme: light)" },
      { url: `${iconRoot}/favicon-dark.png`, sizes: "64x64", type: "image/png", media: "(prefers-color-scheme: dark)" },
      ...(developmentVariant ? [] : [{ url: "/favicon.ico", sizes: "any" }]),
    ],
    ...(developmentVariant ? { shortcut: "/icons/dev/favicon.png" } : {}),
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
export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  await connection();
  const preview = previewInfo();
  return (
    <html lang="ru" data-theme="light" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{preview && <aside role="status" style={{ background: "#ffda73", color: "#1b1608", padding: "10px 16px", fontSize: "14px", textAlign: "center", overflowWrap: "anywhere" }}>
        Превью ветки {preview.branch}, коммит {preview.sha}. Данные общие с DEV.
        {preview.backendChanged && " Серверные изменения ветки не установлены."}
      </aside>}<AppStartupBoundary>{children}</AppStartupBoundary></body>
    </html>
  );
}
