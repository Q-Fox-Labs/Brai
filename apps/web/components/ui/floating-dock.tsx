"use client";
/**
 * Note: Use position fixed according to your needs
 * Desktop navbar is better positioned at the bottom
 * Mobile navbar is better positioned at bottom right.
 **/

import { cn } from "@/components/ui/cn";
import {
  AnimatePresence,
  MotionValue,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from "motion/react";

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { NavigationIndicator, type NavigationIndicatorPosition } from "@/components/ui/navigation-indicator";

type FloatingDockItem = {
  title: string;
  icon: React.ReactNode;
  href: string;
  active?: boolean;
  fillIcon?: boolean;
  onClick?: () => void;
  indicator?: ReactNode;
  indicatorPosition?: NavigationIndicatorPosition;
};

export const FloatingDock = ({
  items,
  desktopClassName,
  mobileClassName,
}: {
  items: FloatingDockItem[];
  desktopClassName?: string;
  mobileClassName?: string;
}) => {
  return (
    <>
      <FloatingDockDesktop items={items} className={desktopClassName} />
      <FloatingDockMobile items={items} className={mobileClassName} />
    </>
  );
};

const FloatingDockMobile = ({
  items,
  className,
}: {
  items: FloatingDockItem[];
  className?: string;
}) => {
  return (
    <div className={cn("hidden items-center gap-2 rounded-2xl px-2 py-1 max-[860px]:flex", className)}>
      {items.map((item) => (
        <a
          href={item.href}
          key={item.title}
          role={item.onClick ? "button" : undefined}
          aria-label={item.title}
          aria-current={item.active ? "page" : undefined}
          onClick={(event) => {
            if (!item.onClick) return;
            event.preventDefault();
            item.onClick();
          }}
          className={cn(
            "nav-button relative flex h-11 w-11 items-center justify-center rounded-full text-neutral-500 dark:text-neutral-300",
            item.active
              ? "bg-accent text-accent-foreground"
              : "bg-transparent",
          )}
        >
          <div className={cn(item.fillIcon ? "h-full w-full" : "h-5 w-5")}>{item.icon}</div>
          <span className="nav-label hidden">{item.title}</span>
          {item.indicator ? <NavigationIndicator position={item.indicatorPosition}>{item.indicator}</NavigationIndicator> : null}
        </a>
      ))}
    </div>
  );
};

const FloatingDockDesktop = ({
  items,
  className,
}: {
  items: FloatingDockItem[];
  className?: string;
}) => {
  const mouseX = useMotionValue(Infinity);
  return (
    <motion.div
      onMouseMove={(e) => mouseX.set(e.pageX)}
      onMouseLeave={() => mouseX.set(Infinity)}
      className={cn(
        "mx-auto hidden h-16 items-end gap-4 rounded-2xl bg-gray-50 px-4 pb-3 dark:bg-neutral-900 min-[861px]:flex",
        className,
      )}
    >
      {items.map((item) => (
        <IconContainer mouseX={mouseX} key={item.title} {...item} />
      ))}
    </motion.div>
  );
};

function IconContainer({
  mouseX,
  title,
  icon,
  href,
  active,
  fillIcon,
  onClick,
  indicator,
  indicatorPosition,
}: FloatingDockItem & {
  mouseX: MotionValue;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const distance = useTransform(mouseX, (val) => {
    const bounds = ref.current?.getBoundingClientRect() ?? { x: 0, width: 0 };

    return val - bounds.x - bounds.width / 2;
  });

  const widthTransform = useTransform(distance, [-150, 0, 150], [40, 80, 40]);
  const heightTransform = useTransform(distance, [-150, 0, 150], [40, 80, 40]);

  const widthTransformIcon = useTransform(distance, [-150, 0, 150], [20, 40, 20]);
  const heightTransformIcon = useTransform(
    distance,
    [-150, 0, 150],
    [20, 40, 20],
  );

  const width = useSpring(widthTransform, {
    mass: 0.1,
    stiffness: 150,
    damping: 12,
  });
  const height = useSpring(heightTransform, {
    mass: 0.1,
    stiffness: 150,
    damping: 12,
  });

  const widthIcon = useSpring(widthTransformIcon, {
    mass: 0.1,
    stiffness: 150,
    damping: 12,
  });
  const heightIcon = useSpring(heightTransformIcon, {
    mass: 0.1,
    stiffness: 150,
    damping: 12,
  });

  const [hovered, setHovered] = useState(false);

  return (
    <a
      href={href}
      role={onClick ? "button" : undefined}
      aria-label={title}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        if (!onClick) return;
        event.preventDefault();
        onClick();
      }}
    >
      <motion.div
        ref={ref}
        style={{ width, height }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          "relative flex aspect-square items-center justify-center rounded-full bg-card text-muted-foreground",
          active && "bg-accent text-accent-foreground",
        )}
      >
        <AnimatePresence>
          {hovered && (
            <motion.div
              initial={{ opacity: 0, y: 10, x: "-50%" }}
              animate={{ opacity: 1, y: 0, x: "-50%" }}
              exit={{ opacity: 0, y: 2, x: "-50%" }}
              className="absolute -top-8 left-1/2 w-fit rounded-md border border-gray-200 bg-gray-100 px-2 py-0.5 text-xs whitespace-pre text-neutral-700 dark:border-neutral-900 dark:bg-neutral-800 dark:text-white"
            >
              {title}
            </motion.div>
          )}
        </AnimatePresence>
        {fillIcon ? (
          <div className="absolute inset-0 flex items-center justify-center">
            {icon}
          </div>
        ) : (
          <motion.div
            style={{ width: widthIcon, height: heightIcon }}
            className="flex items-center justify-center"
          >
            {icon}
          </motion.div>
        )}
        {indicator ? <NavigationIndicator position={indicatorPosition}>{indicator}</NavigationIndicator> : null}
      </motion.div>
    </a>
  );
}
