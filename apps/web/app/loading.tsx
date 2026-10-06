"use client";
// ABOUTME: Удерживает общую корневую заставку при серверной загрузке любого маршрута.
// ABOUTME: Собственная заставка маршруту не нужна; снятие принадлежит корневой границе.
import { useStartupReady } from "./shell/app-startup-boundary";

/** Смена fallback на страницу снимает только ожидание серверного маршрута. */
export default function Loading() {
  useStartupReady(false);
  return null;
}
