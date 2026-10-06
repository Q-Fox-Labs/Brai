"use client";

import type { ReactElement } from "react";
import { Archive, CircleUserRound, Command, Cpu, Download, LogOut, Settings, type LucideIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/components/ui/cn";
import { NavigationIndicator, UpdateNavigationDot } from "@/components/ui/navigation-indicator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Ограничивает данные меню отображаемыми именем и email; auth-команды остаются у вызывающей стороны. */
type MenuUser = { name?: string | null; email?: string | null };

type MenuItem = {
  active?: boolean;
  destructive?: boolean;
  icon: LucideIcon;
  label: string;
  onSelect: () => void | Promise<void>;
  indicator?: boolean;
  iconClassName?: string;
};

type BraiUserMenuProps = {
  activeSection?: "profile" | "archive" | "brai-cmd" | "engine" | "settings" | string;
  className?: string;
  showEngine?: boolean;
  engineDownloading?: boolean;
  engineHasUpdate?: boolean;
  user: MenuUser | null;
  onArchive: () => void;
  onBraiCmd: () => void;
  onEngine: () => void;
  onLogout: () => void | Promise<void>;
  onProfile: () => void;
  onSettings: () => void;
};

type BraiUserDropdownMenuProps = BraiUserMenuProps & {
  align?: "start" | "center" | "end";
  defaultOpen?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  trigger: ReactElement;
};

const itemClass = "p-2 text-sm font-medium text-popover-foreground cursor-pointer gap-2";

export function BraiUserDropdownMenu({
  align = "end",
  defaultOpen,
  side = "right",
  sideOffset = 10,
  trigger,
  ...menuProps
}: BraiUserDropdownMenuProps) {
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild className="cursor-pointer">
        {trigger}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="w-72 rounded-2xl data-[state=closed]:slide-out-to-left-2 data-[state=open]:slide-in-from-left-2 data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-100 duration-300"
      >
        <BraiUserMenuPanel dropdown {...menuProps} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BraiUserMenuPanel({
  activeSection,
  className,
  showEngine = true,
  engineDownloading = false,
  engineHasUpdate = false,
  user,
  onArchive,
  onBraiCmd,
  onEngine,
  onLogout,
  onProfile,
  onSettings,
  dropdown = false,
}: BraiUserMenuProps & { dropdown?: boolean }) {
  const mainItems: MenuItem[] = [
    { label: "Профиль", icon: CircleUserRound, active: activeSection === "profile", onSelect: onProfile },
    { label: "Архив", icon: Archive, active: activeSection === "archive", onSelect: onArchive },
    { label: "Brai CMD", icon: Command, active: activeSection === "brai-cmd", onSelect: onBraiCmd },
    ...(showEngine ? [{
      label: "Engine",
      icon: engineHasUpdate ? Download : Cpu,
      active: activeSection === "engine",
      onSelect: onEngine,
      indicator: engineHasUpdate,
      iconClassName: engineDownloading ? "motion-safe:animate-bounce" : undefined,
    }] : []),
  ];
  const settingsItems: MenuItem[] = [
    { label: "Настройки", icon: Settings, active: activeSection === "settings", onSelect: onSettings },
  ];
  const logoutItem: MenuItem = { label: "Выход", icon: LogOut, destructive: true, onSelect: onLogout };

  if (dropdown) {
    return (
      <DropdownMenuGroup className={className}>
        <UserInfoLabel user={user} />
        <DropdownMenuSeparator />
        {mainItems.map((item) => <DropdownItem key={item.label} item={item} />)}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {settingsItems.map((item) => <DropdownItem key={item.label} item={item} />)}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownItem item={logoutItem} />
      </DropdownMenuGroup>
    );
  }

  return (
    <div className={cn("grid rounded-2xl bg-card text-card-foreground", className)}>
      <UserInfoBlock user={user} />
      <MenuSeparator />
      <MenuButtonList items={mainItems} />
      <MenuSeparator />
      <MenuButtonList items={settingsItems} />
      <MenuSeparator />
      <MenuButton item={logoutItem} />
    </div>
  );
}

export function BraiUserAvatar({ user, className }: { user: MenuUser | null; className?: string }) {
  return (
    <Avatar className={cn("size-10 cursor-pointer", className)}>
      <AvatarFallback className="bg-primary text-xs font-semibold text-primary-foreground">
        {userInitials(user)}
      </AvatarFallback>
    </Avatar>
  );
}

function UserInfoLabel({ user }: { user: MenuUser | null }) {
  const profile = userProfile(user);
  return (
    <DropdownMenuLabel className="flex min-w-0 items-center gap-3 px-4 py-3">
      <div className="relative">
        <BraiUserAvatar user={user} />
        <span className="absolute bottom-0 right-0 size-2 rounded-full bg-green-600 ring-2 ring-card" />
      </div>

      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-popover-foreground">{profile.name}</span>
        <span className="truncate text-sm text-muted-foreground">{profile.email}</span>
      </div>
    </DropdownMenuLabel>
  );
}

function UserInfoBlock({ user }: { user: MenuUser | null }) {
  const profile = userProfile(user);
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-3">
      <div className="relative">
        <BraiUserAvatar user={user} />
        <span className="absolute bottom-0 right-0 size-2 rounded-full bg-green-600 ring-2 ring-card" />
      </div>

      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-popover-foreground">{profile.name}</span>
        <span className="truncate text-sm text-muted-foreground">{profile.email}</span>
      </div>
    </div>
  );
}

function DropdownItem({ item }: { item: MenuItem }) {
  const Icon = item.icon;
  return (
    <DropdownMenuItem
      aria-label={item.label}
      variant={item.destructive ? "destructive" : "default"}
      className={cn(itemClass, item.active && "bg-accent text-accent-foreground")}
      onSelect={() => void item.onSelect()}
    >
      <span className="relative flex size-5 shrink-0 items-center justify-center">
        <Icon className={cn("size-5", item.iconClassName)} aria-hidden="true" />
        {item.indicator ? <NavigationIndicator><UpdateNavigationDot /></NavigationIndicator> : null}
      </span>
      <span>{item.label}</span>
    </DropdownMenuItem>
  );
}

function MenuButtonList({ items }: { items: MenuItem[] }) {
  return (
    <div className="grid gap-1">
      {items.map((item) => <MenuButton key={item.label} item={item} />)}
    </div>
  );
}

function MenuButton({ item }: { item: MenuItem }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      aria-label={item.label}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-sm p-2 text-left text-sm font-medium text-popover-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
        item.active && "bg-accent text-accent-foreground",
        item.destructive && "text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive",
      )}
      onClick={() => void item.onSelect()}
    >
      <span className="relative flex size-5 shrink-0 items-center justify-center">
        <Icon className={cn("size-5", item.iconClassName)} aria-hidden="true" />
        {item.indicator ? <NavigationIndicator><UpdateNavigationDot /></NavigationIndicator> : null}
      </span>
      <span>{item.label}</span>
    </button>
  );
}

function MenuSeparator() {
  return <div className="my-1 h-px bg-border" aria-hidden="true" />;
}

function userProfile(user: MenuUser | null) {
  return {
    name: user?.name?.trim() || user?.email?.trim() || "Brai",
    email: user?.email?.trim() || "profile@brai.local",
  };
}

function userInitials(user: MenuUser | null) {
  const source = user?.name?.trim() || user?.email?.split("@")[0]?.trim() || "Brai";
  const words = source.split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? `${words[0][0] ?? ""}${words[1][0] ?? ""}` : source[0] ?? "B";
  return letters.toLocaleUpperCase();
}

export default BraiUserDropdownMenu;
