import Markdown, { type Components } from "react-markdown";

import { cn } from "@/components/ui/cn";

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="scroll-m-20 text-2xl font-semibold leading-tight tracking-normal text-balance">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-9 scroll-m-20 border-b pb-2 text-xl font-semibold leading-tight tracking-normal first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-7 scroll-m-20 text-lg font-semibold leading-tight tracking-normal">{children}</h3>
  ),
  h4: ({ children }) => <h4 className="mt-6 scroll-m-20 text-base font-semibold leading-tight">{children}</h4>,
  p: ({ children }) => <p className="leading-7 [&:not(:first-child)]:mt-5">{children}</p>,
  a: ({ children, href }) => (
    <a className="font-semibold text-primary underline underline-offset-4" href={href}>
      {children}
    </a>
  ),
  blockquote: ({ children }) => <blockquote className="mt-6 border-l-2 pl-6 italic">{children}</blockquote>,
  ul: ({ children }) => <ul className="my-6 ml-6 list-disc [&>li]:mt-2">{children}</ul>,
  ol: ({ children }) => <ol className="my-6 ml-6 list-decimal [&>li]:mt-2">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  hr: () => <hr className="my-8 border-border" />,
  code: ({ children, className }) => (
    <code
      className={cn(
        "break-words rounded bg-muted px-1.5 py-0.5 font-mono text-sm font-normal",
        className && "block whitespace-pre-wrap p-4",
        className,
      )}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => <pre className="my-6 rounded-md bg-muted p-0 whitespace-pre-wrap">{children}</pre>,
  table: ({ children }) => (
    <div className="my-6 w-full overflow-hidden">
      <table className="w-full">{children}</table>
    </div>
  ),
  tr: ({ children }) => <tr className="m-0 border-t p-0 even:bg-muted">{children}</tr>,
  th: ({ children }) => (
    <th className="border px-4 py-2 text-left font-semibold [&[align=center]]:text-center [&[align=right]]:text-right">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right">
      {children}
    </td>
  ),
};

const markdownSyntaxPatterns = [
  /^\s{0,3}#{1,6}\s*\S/m,
  /^\s{0,3}(?:[-*+]|\d+[.)])\s+\S/m,
  /^\s{0,3}>\s?\S/m,
  /^\s{0,3}(?:[-*_]\s*){3,}$/m,
  /```|~~~/,
  /!?\[[^\]\n]+\]\([^)]+\)/,
  /(?:\*\*|__)[\s\S]+?(?:\*\*|__)/,
  /(^|[\s([{])\*[^*\s][^*\n]*\*(?=$|[\s)\]},.!?:;])/,
  /(^|[\s([{])_[^_\s][^_\n]*_(?=$|[\s)\]},.!?:;])/,
  /`[^`\n]+`/,
];

export function hasMarkdownSyntax(source: string): boolean {
  return markdownSyntaxPatterns.some((pattern) => pattern.test(source));
}

export function MarkdownContent({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn("markdown-content min-w-0 text-sm font-normal leading-7 text-foreground [overflow-wrap:anywhere]", className)}>
      <Markdown components={markdownComponents} skipHtml>
        {source}
      </Markdown>
    </div>
  );
}
