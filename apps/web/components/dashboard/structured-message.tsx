import type { ReactNode } from "react";

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[1]) {
      nodes.push(<strong key={`${match.index}-b`}>{match[1]}</strong>);
    } else if (match[2]) {
      nodes.push(<em key={`${match.index}-i`}>{match[2]}</em>);
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [text];
}

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "number"; index: string; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "blank" };

function classifyLine(line: string): Block {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "blank" };
  const h = trimmed.match(/^(#{1,3})\s+(.*)$/);
  if (h) {
    const hashes = h[1] ?? "";
    return { kind: "heading", level: hashes.length as 1 | 2 | 3, text: h[2] ?? "" };
  }
  const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
  if (bullet) return { kind: "bullet", text: bullet[1] ?? "" };
  const number = trimmed.match(/^(\d+[.)])\s+(.*)$/);
  if (number) return { kind: "number", index: number[1] ?? "", text: number[2] ?? "" };
  return { kind: "paragraph", text: trimmed };
}

export function StructuredMessage({
  content,
  className = "",
}: {
  content: string;
  className?: string;
}) {
  const blocks = content.split(/\n/).map(classifyLine);
  const output: ReactNode[] = [];
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];
    if (!block) {
      i += 1;
      continue;
    }

    if (block.kind === "blank") {
      output.push(<div key={`gap-${i}`} className="h-2" />);
      i += 1;
      continue;
    }

    if (block.kind === "heading") {
      const Tag = block.level === 1 ? "h4" : block.level === 2 ? "h5" : "h6";
      output.push(
        <Tag
          key={`h-${i}`}
          className={`font-semibold ${block.level === 1 ? "text-base" : block.level === 2 ? "text-sm" : "text-xs uppercase tracking-wide"}`}
        >
          {renderInline(block.text)}
        </Tag>,
      );
      i += 1;
      continue;
    }

    if (block.kind === "bullet" || block.kind === "number") {
      // Collect a run of consecutive bullet/number lines.
      // Numbered lines get their index displayed; bullet lines get a dot marker.
      // When a numbered item is immediately followed by bullet sub-items we
      // render the number as a mini-section label and the bullets as an
      // indented sub-list so the LLM's typical "1) SECTION\n• item" format
      // displays with clear visual hierarchy.
      const items: Block[] = [];
      while (
        i < blocks.length &&
        (blocks[i]?.kind === "bullet" || blocks[i]?.kind === "number")
      ) {
        items.push(blocks[i]!);
        i += 1;
      }

      // Group: split into runs of [number + following bullets] OR standalone bullets
      const segments: Array<{ header: (Extract<Block, { kind: "number" }>) | null; bullets: Block[] }> = [];
      let j = 0;
      while (j < items.length) {
        const cur = items[j]!;
        if (cur.kind === "number") {
          const sub: Block[] = [];
          let k = j + 1;
          while (k < items.length && items[k]?.kind === "bullet") {
            sub.push(items[k]!);
            k += 1;
          }
          segments.push({ header: cur as Extract<Block, { kind: "number" }>, bullets: sub });
          j = k;
        } else {
          // standalone bullet(s) with no preceding number header
          const sub: Block[] = [];
          while (j < items.length && items[j]?.kind === "bullet") {
            sub.push(items[j]!);
            j += 1;
          }
          segments.push({ header: null, bullets: sub });
        }
      }

      output.push(
        <div key={`section-${i}`} className="space-y-1">
          {segments.map((seg, si) =>
            seg.header !== null ? (
              <div key={`seg-${si}`} className="space-y-0.5">
                {/* Numbered section header */}
                <p className="flex items-baseline gap-1.5 font-semibold">
                  <span className="shrink-0 tabular-nums text-[0.8em] opacity-80">
                    {seg.header.index}
                  </span>
                  <span className="min-w-0">{renderInline(seg.header.text)}</span>
                </p>
                {/* Sub-bullets indented under the number */}
                {seg.bullets.length > 0 && (
                  <ul className="ml-4 space-y-0.5 border-l border-current/15 pl-3">
                    {seg.bullets.map((b, bi) => (
                      <li key={`b-${si}-${bi}`} className="flex gap-2">
                        <span className="mt-[0.55em] h-1.5 w-1.5 shrink-0 rounded-full bg-current/60" aria-hidden />
                        <span className="min-w-0 flex-1">{renderInline((b as Extract<Block, { kind: "bullet" }>).text)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              /* Standalone bullets (no number header) */
              <ul key={`seg-${si}`} className="space-y-1 pl-4">
                {seg.bullets.map((b, bi) => (
                  <li key={`b-${si}-${bi}`} className="flex gap-2">
                    <span className="mt-[0.55em] h-1.5 w-1.5 shrink-0 rounded-full bg-current/70" aria-hidden />
                    <span className="min-w-0 flex-1">{renderInline((b as Extract<Block, { kind: "bullet" }>).text)}</span>
                  </li>
                ))}
              </ul>
            ),
          )}
        </div>,
      );
      continue;
    }

    const paras: string[] = [];
    while (
      i < blocks.length &&
      blocks[i]?.kind === "paragraph"
    ) {
      paras.push((blocks[i] as Extract<Block, { kind: "paragraph" }>).text);
      i += 1;
    }
    output.push(
      <p key={`p-${i}`} className="whitespace-pre-wrap leading-relaxed">
        {renderInline(paras.join("\n"))}
      </p>,
    );
  }

  return <div className={`space-y-2 ${className}`}>{output}</div>;
}
