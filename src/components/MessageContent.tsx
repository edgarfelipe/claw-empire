/**
 * Lightweight markdown renderer for chat messages.
 * Handles: tables, bold, italic, links, inline code, code blocks, headers, lists.
 * Also renders message attachments (images, audio, files).
 */

import { useState, useRef, useCallback } from "react";
import type { JSX } from "react";
import type { MessageAttachment } from "../types";

interface MessageContentProps {
  content: string;
  className?: string;
  attachments?: MessageAttachment[];
}

/** Parse a markdown table string into header + rows */
function parseTable(block: string): { headers: string[]; rows: string[][] } | null {
  const lines = block
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length < 2) return null;

  const parseCells = (line: string) =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const headers = parseCells(lines[0]);
  // Check line[1] is separator (---|----|---)
  const sep = lines[1];
  if (!/^[\s|:-]+$/.test(sep)) return null;

  const rows = lines.slice(2).map(parseCells);
  return { headers, rows };
}

/** Render inline markdown: bold, italic, code, links */
function renderInline(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  // Pattern: **bold**, *italic*, `code`, [text](url), @mention
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\[([^\]]+)\]\(([^)]+)\))|(@[\w가-힣]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[1]) {
      // **bold**
      parts.push(
        <strong key={key++} className="font-bold text-white">
          {match[2]}
        </strong>,
      );
    } else if (match[3]) {
      // *italic*
      parts.push(
        <em key={key++} className="italic">
          {match[4]}
        </em>,
      );
    } else if (match[5]) {
      // `code`
      parts.push(
        <code key={key++} className="px-1 py-0.5 bg-gray-700 text-emerald-300 rounded text-xs font-mono">
          {match[6]}
        </code>,
      );
    } else if (match[7]) {
      // [text](url)
      parts.push(
        <a
          key={key++}
          href={match[9]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 underline hover:text-blue-300"
        >
          {match[8]}
        </a>,
      );
    } else if (match[10]) {
      // @mention
      parts.push(
        <span key={key++} className="px-1 py-0.5 bg-blue-500/20 text-blue-300 rounded font-medium">
          {match[10]}
        </span>,
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [text];
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ImageAttachment({ att }: { att: MessageAttachment }) {
  const [lightbox, setLightbox] = useState(false);
  return (
    <>
      <button onClick={() => setLightbox(true)} className="block cursor-zoom-in">
        <img
          src={att.thumbnail_url || att.url}
          alt={att.file_name}
          className="max-w-[300px] rounded-lg shadow-md transition-transform hover:scale-[1.02]"
          loading="lazy"
        />
      </button>
      {lightbox && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setLightbox(false)}
        >
          <img
            src={att.url}
            alt={att.file_name}
            className="max-h-[90vh] max-w-[90vw] rounded-lg shadow-2xl"
          />
          <button
            onClick={() => setLightbox(false)}
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
              <path fillRule="evenodd" d="M5.47 5.47a.75.75 0 011.06 0L12 10.94l5.47-5.47a.75.75 0 111.06 1.06L13.06 12l5.47 5.47a.75.75 0 11-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 01-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 010-1.06z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}

function AudioAttachment({ att }: { att: MessageAttachment }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(att.duration_ms ? att.duration_ms / 1000 : 0);

  const togglePlay = useCallback(() => {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setPlaying(!playing);
  }, [playing]);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-600 bg-gray-800/80 px-3 py-2 max-w-[280px]">
      <audio
        ref={audioRef}
        src={att.url}
        onLoadedMetadata={() => {
          if (audioRef.current) setDuration(audioRef.current.duration);
        }}
        onTimeUpdate={() => {
          if (audioRef.current && duration > 0) {
            setProgress((audioRef.current.currentTime / duration) * 100);
          }
        }}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
        }}
      />
      <button
        onClick={togglePlay}
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-purple-600 text-white hover:bg-purple-500"
      >
        {playing ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
            <path fillRule="evenodd" d="M6.75 5.25a.75.75 0 01.75-.75H9a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H7.5a.75.75 0 01-.75-.75V5.25zm7.5 0A.75.75 0 0115 4.5h1.5a.75.75 0 01.75.75v13.5a.75.75 0 01-.75.75H15a.75.75 0 01-.75-.75V5.25z" clipRule="evenodd" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
            <path fillRule="evenodd" d="M4.5 5.653c0-1.426 1.529-2.33 2.779-1.643l11.54 6.348c1.295.712 1.295 2.573 0 3.285L7.28 19.991c-1.25.687-2.779-.217-2.779-1.643V5.653z" clipRule="evenodd" />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="h-1.5 w-full rounded-full bg-gray-600 overflow-hidden">
          <div
            className="h-full rounded-full bg-purple-400 transition-all duration-100"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="mt-1 text-[10px] text-gray-400">{formatTime(duration > 0 ? duration : 0)}</p>
      </div>
    </div>
  );
}

function FileAttachment({ att }: { att: MessageAttachment }) {
  return (
    <a
      href={att.url}
      download={att.file_name}
      className="flex items-center gap-3 rounded-xl border border-gray-600 bg-gray-800/80 px-3 py-2.5 max-w-[280px] hover:bg-gray-700/80 transition-colors"
    >
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-blue-600/20 text-blue-400">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
          <path fillRule="evenodd" d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0016.5 9h-1.875a1.875 1.875 0 01-1.875-1.875V5.25A3.75 3.75 0 009 1.5H5.625z" clipRule="evenodd" />
          <path d="M12.971 1.816A5.23 5.23 0 0114.25 5.25v1.875c0 .207.168.375.375.375H16.5a5.23 5.23 0 013.434 1.279 9.768 9.768 0 00-6.963-6.963z" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-200">{att.file_name}</p>
        <p className="text-[10px] text-gray-500">{formatFileSize(att.file_size)}</p>
      </div>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 flex-shrink-0 text-gray-500">
        <path fillRule="evenodd" d="M12 2.25a.75.75 0 01.75.75v11.69l3.22-3.22a.75.75 0 111.06 1.06l-4.5 4.5a.75.75 0 01-1.06 0l-4.5-4.5a.75.75 0 111.06-1.06l3.22 3.22V3a.75.75 0 01.75-.75zm-9 13.5a.75.75 0 01.75.75v2.25a1.5 1.5 0 001.5 1.5h13.5a1.5 1.5 0 001.5-1.5V16.5a.75.75 0 011.5 0v2.25a3 3 0 01-3 3H5.25a3 3 0 01-3-3V16.5a.75.75 0 01.75-.75z" clipRule="evenodd" />
      </svg>
    </a>
  );
}

function AttachmentRenderer({ attachments }: { attachments: MessageAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {attachments.map((att) => {
        if (att.file_type === "image") return <ImageAttachment key={att.id} att={att} />;
        if (att.file_type === "audio") return <AudioAttachment key={att.id} att={att} />;
        return <FileAttachment key={att.id} att={att} />;
      })}
    </div>
  );
}

export default function MessageContent({ content, className = "", attachments }: MessageContentProps) {
  // Split content into blocks (code blocks, tables, and regular text)
  const blocks: { type: "text" | "code" | "table"; content: string }[] = [];

  // Extract fenced code blocks first
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIdx = 0;
  let cbMatch: RegExpExecArray | null;

  while ((cbMatch = codeBlockRegex.exec(content)) !== null) {
    if (cbMatch.index > lastIdx) {
      blocks.push({ type: "text", content: content.slice(lastIdx, cbMatch.index) });
    }
    blocks.push({ type: "code", content: cbMatch[2].trimEnd() });
    lastIdx = cbMatch.index + cbMatch[0].length;
  }
  if (lastIdx < content.length) {
    blocks.push({ type: "text", content: content.slice(lastIdx) });
  }

  // Further split text blocks to extract tables
  const finalBlocks: typeof blocks = [];
  for (const block of blocks) {
    if (block.type !== "text") {
      finalBlocks.push(block);
      continue;
    }

    // Look for table patterns (lines starting with |)
    const lines = block.content.split("\n");
    let tableLines: string[] = [];
    let textLines: string[] = [];

    for (const line of lines) {
      if (/^\s*\|/.test(line)) {
        if (textLines.length > 0) {
          finalBlocks.push({ type: "text", content: textLines.join("\n") });
          textLines = [];
        }
        tableLines.push(line);
      } else {
        if (tableLines.length > 0) {
          finalBlocks.push({ type: "table", content: tableLines.join("\n") });
          tableLines = [];
        }
        textLines.push(line);
      }
    }
    if (tableLines.length > 0) {
      finalBlocks.push({ type: "table", content: tableLines.join("\n") });
    }
    if (textLines.length > 0) {
      finalBlocks.push({ type: "text", content: textLines.join("\n") });
    }
  }

  const isAttachmentOnly = content === "[attachment]" && attachments && attachments.length > 0;

  return (
    <div className={`space-y-2 ${className}`}>
      {!isAttachmentOnly && finalBlocks.map((block, bi) => {
        if (block.type === "code") {
          return (
            <pre
              key={bi}
              className="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-xs font-mono text-green-300 overflow-x-auto whitespace-pre-wrap"
            >
              {block.content}
            </pre>
          );
        }

        if (block.type === "table") {
          const table = parseTable(block.content);
          if (table) {
            return (
              <div key={bi} className="overflow-x-auto rounded-lg border border-gray-600">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-700/80">
                      {table.headers.map((h, hi) => (
                        <th
                          key={hi}
                          className="px-2.5 py-1.5 text-left font-semibold text-gray-200 border-b border-gray-600 whitespace-nowrap"
                        >
                          {renderInline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row, ri) => (
                      <tr key={ri} className={ri % 2 === 0 ? "bg-gray-800/50" : "bg-gray-800/30"}>
                        {row.map((cell, ci) => (
                          <td
                            key={ci}
                            className="px-2.5 py-1.5 text-gray-300 border-b border-gray-700/50 whitespace-nowrap"
                          >
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          // Fallback: render as text if not a valid table
          return <span key={bi}>{block.content}</span>;
        }

        // Text block: handle headers, lists, paragraphs
        const textLines = block.content.split("\n");
        return (
          <div key={bi}>
            {textLines.map((line, li) => {
              const trimmed = line.trim();
              if (!trimmed) return <div key={li} className="h-1" />;

              // Headers
              if (trimmed.startsWith("### ")) {
                return (
                  <div key={li} className="font-bold text-white text-sm mt-1">
                    {renderInline(trimmed.slice(4))}
                  </div>
                );
              }
              if (trimmed.startsWith("## ")) {
                return (
                  <div key={li} className="font-bold text-white text-sm mt-1">
                    {renderInline(trimmed.slice(3))}
                  </div>
                );
              }
              if (trimmed.startsWith("# ")) {
                return (
                  <div key={li} className="font-bold text-white mt-1">
                    {renderInline(trimmed.slice(2))}
                  </div>
                );
              }

              // Unordered list
              if (/^[-*]\s/.test(trimmed)) {
                return (
                  <div key={li} className="flex gap-1.5 items-start">
                    <span className="text-gray-500 mt-0.5 shrink-0">•</span>
                    <span>{renderInline(trimmed.slice(2))}</span>
                  </div>
                );
              }

              // Ordered list
              const olMatch = trimmed.match(/^(\d+)[.)]\s(.*)/);
              if (olMatch) {
                return (
                  <div key={li} className="flex gap-1.5 items-start">
                    <span className="text-gray-500 mt-0.5 shrink-0 min-w-[1em] text-right">{olMatch[1]}.</span>
                    <span>{renderInline(olMatch[2])}</span>
                  </div>
                );
              }

              // Horizontal rule
              if (/^[-*_]{3,}$/.test(trimmed)) {
                return <hr key={li} className="border-gray-600 my-1" />;
              }

              // Normal paragraph
              return <div key={li}>{renderInline(trimmed)}</div>;
            })}
          </div>
        );
      })}
      {attachments && attachments.length > 0 && <AttachmentRenderer attachments={attachments} />}
    </div>
  );
}
