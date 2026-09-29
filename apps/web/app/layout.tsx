// ABOUTME: Задаёт общий HTML каркас веб-приложения Brai.
// ABOUTME: Не содержит прикладной логики и внешних подключений.
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Brai",
  description: "Brai web application",
};

/** Отображает корневую разметку маршрутов приложения. */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
