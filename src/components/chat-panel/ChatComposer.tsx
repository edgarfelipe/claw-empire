import { useState, useRef, useCallback, useEffect } from "react";
import type { KeyboardEvent, RefObject, DragEvent, ClipboardEvent } from "react";
import type { Agent, MessageAttachment } from "../../types";
import ChatModeHint from "./ChatModeHint";

type ChatMode = "chat" | "task" | "announcement" | "report";
type Tr = (ko: string, en: string, ja?: string, zh?: string) => string;

interface PendingFile {
  file: File;
  preview?: string; // data URL for images
  uploading: boolean;
  progress: number;
  attachment?: MessageAttachment;
  error?: string;
}

interface ChatComposerProps {
  mode: ChatMode;
  input: string;
  selectedAgent: Agent | null;
  isDirectiveMode: boolean;
  isAnnouncementMode: boolean;
  tr: Tr;
  getAgentName: (agent: Agent | null | undefined) => string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onModeChange: (mode: ChatMode) => void;
  onInputChange: (value: string) => void;
  onSend: (attachmentIds?: string[]) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ChatComposer({
  mode,
  input,
  selectedAgent,
  isDirectiveMode,
  isAnnouncementMode,
  tr,
  getAgentName,
  textareaRef,
  onModeChange,
  onInputChange,
  onSend,
  onKeyDown,
}: ChatComposerProps) {
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Cleanup recording timer on unmount
  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };
  }, []);

  const uploadFiles = useCallback(async (files: File[]) => {
    const newPending: PendingFile[] = files.map((file) => ({
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      uploading: true,
      progress: 0,
    }));

    setPendingFiles((prev) => [...prev, ...newPending]);

    const formData = new FormData();
    for (const file of files) {
      formData.append("files", file);
    }

    try {
      const response = await fetch("/api/messages/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Upload failed");

      const data = await response.json();
      const attachments = data.attachments as MessageAttachment[];

      setPendingFiles((prev) => {
        const updated = [...prev];
        let attIdx = 0;
        for (let i = 0; i < updated.length; i++) {
          if (updated[i].uploading && files.includes(updated[i].file)) {
            if (attIdx < attachments.length) {
              updated[i] = { ...updated[i], uploading: false, progress: 100, attachment: attachments[attIdx] };
              attIdx++;
            }
          }
        }
        return updated;
      });
    } catch {
      setPendingFiles((prev) =>
        prev.map((p) =>
          files.includes(p.file) ? { ...p, uploading: false, error: "Upload failed" } : p,
        ),
      );
    }
  }, []);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) void uploadFiles(files);
      e.target.value = "";
    },
    [uploadFiles],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(e.clipboardData.items);
      const imageItems = items.filter((item) => item.type.startsWith("image/"));
      if (imageItems.length > 0) {
        e.preventDefault();
        const files = imageItems.map((item) => item.getAsFile()).filter(Boolean) as File[];
        if (files.length > 0) void uploadFiles(files);
      }
    },
    [uploadFiles],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) void uploadFiles(files);
    },
    [uploadFiles],
  );

  const removePendingFile = useCallback((index: number) => {
    setPendingFiles((prev) => {
      const updated = [...prev];
      if (updated[index]?.preview) URL.revokeObjectURL(updated[index].preview!);
      updated.splice(index, 1);
      return updated;
    });
  }, []);

  // Audio recording
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const file = new File([blob], `recording_${Date.now()}.webm`, { type: "audio/webm" });
        void uploadFiles([file]);
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);

      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((t) => t + 1);
      }, 1000);
    } catch {
      console.error("Could not access microphone");
    }
  }, [uploadFiles]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }, []);

  const handleSendWithAttachments = useCallback(() => {
    const attachmentIds = pendingFiles
      .filter((p) => p.attachment)
      .map((p) => p.attachment!.id);
    onSend(attachmentIds.length > 0 ? attachmentIds : undefined);
    // Clean up previews
    for (const p of pendingFiles) {
      if (p.preview) URL.revokeObjectURL(p.preview);
    }
    setPendingFiles([]);
  }, [pendingFiles, onSend]);

  const hasContent = input.trim().length > 0 || pendingFiles.some((p) => p.attachment);

  const formatRecordingTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <>
      <div className="flex flex-shrink-0 gap-2 border-t border-gray-700/50 px-4 pb-1 pt-3">
        <button
          onClick={() => onModeChange(mode === "task" ? "chat" : "task")}
          disabled={!selectedAgent}
          className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
            mode === "task"
              ? "bg-blue-600 text-white"
              : "bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
          }`}
        >
          <span>📋</span>
          <span>{tr("업무 지시", "Task", "タスク指示", "任务指示")}</span>
        </button>

        <button
          onClick={() => onModeChange(mode === "announcement" ? "chat" : "announcement")}
          className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
            mode === "announcement" ? "bg-yellow-500 text-gray-900" : "bg-gray-700 text-gray-300 hover:bg-gray-600"
          }`}
        >
          <span>📢</span>
          <span>{tr("전사 공지", "Announcement", "全体告知", "全员公告")}</span>
        </button>

        <button
          onClick={() => onModeChange(mode === "report" ? "chat" : "report")}
          disabled={!selectedAgent}
          className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
            mode === "report"
              ? "bg-emerald-600 text-white"
              : "bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
          }`}
        >
          <span>📊</span>
          <span>{tr("보고 요청", "Report", "レポート依頼", "报告请求")}</span>
        </button>
      </div>

      <ChatModeHint mode={mode} isDirectiveMode={isDirectiveMode} tr={tr} />

      {/* Pending file previews */}
      {pendingFiles.length > 0 && (
        <div className="flex flex-shrink-0 gap-2 overflow-x-auto px-4 pb-2">
          {pendingFiles.map((pf, idx) => (
            <div
              key={idx}
              className="relative flex-shrink-0 rounded-lg border border-gray-600 bg-gray-800 p-1"
            >
              {pf.preview ? (
                <img
                  src={pf.preview}
                  alt={pf.file.name}
                  className="h-16 w-16 rounded-md object-cover"
                />
              ) : pf.file.type.startsWith("audio/") ? (
                <div className="flex h-16 w-16 items-center justify-center rounded-md bg-gray-700">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6 text-purple-400">
                    <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-4.5 4.5H4.508c-1.141 0-2.318.664-2.66 1.905A9.76 9.76 0 001.5 12c0 .898.121 1.768.35 2.595.341 1.24 1.518 1.905 2.659 1.905h1.93l4.5 4.5c.945.945 2.561.276 2.561-1.06V4.06zM18.584 5.106a.75.75 0 011.06 0c3.808 3.807 3.808 9.98 0 13.788a.75.75 0 01-1.06-1.06 8.25 8.25 0 000-11.668.75.75 0 010-1.06z" />
                    <path d="M15.932 7.757a.75.75 0 011.061 0 6 6 0 010 8.486.75.75 0 01-1.06-1.061 4.5 4.5 0 000-6.364.75.75 0 010-1.06z" />
                  </svg>
                </div>
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-md bg-gray-700">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6 text-blue-400">
                    <path fillRule="evenodd" d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0016.5 9h-1.875a1.875 1.875 0 01-1.875-1.875V5.25A3.75 3.75 0 009 1.5H5.625z" clipRule="evenodd" />
                    <path d="M12.971 1.816A5.23 5.23 0 0114.25 5.25v1.875c0 .207.168.375.375.375H16.5a5.23 5.23 0 013.434 1.279 9.768 9.768 0 00-6.963-6.963z" />
                  </svg>
                </div>
              )}
              {pf.uploading && (
                <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-400 border-t-white" />
                </div>
              )}
              {pf.error && (
                <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-red-900/50">
                  <span className="text-xs text-red-300">!</span>
                </div>
              )}
              <button
                onClick={() => removePendingFile(idx)}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gray-600 text-xs text-gray-300 shadow-lg hover:bg-red-600 hover:text-white"
              >
                x
              </button>
              <p className="mt-0.5 max-w-[64px] truncate text-center text-[10px] text-gray-500">
                {formatFileSize(pf.file.size)}
              </p>
            </div>
          ))}
        </div>
      )}

      <div
        className={`flex-shrink-0 px-4 pb-4 pt-2 ${isDragOver ? "rounded-xl ring-2 ring-blue-500/50" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="mb-2 flex items-center justify-center rounded-xl border-2 border-dashed border-blue-500/50 bg-blue-500/10 py-4 text-sm text-blue-300">
            {tr("파일을 여기에 놓으세요", "Drop files here", "ファイルをここにドロップ", "将文件拖放到这里")}
          </div>
        )}

        {isRecording && (
          <div className="mb-2 flex items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2">
            <span className="h-3 w-3 animate-pulse rounded-full bg-red-500" />
            <span className="text-sm font-medium text-red-300">
              {tr("녹음 중", "Recording", "録音中", "录音中")} {formatRecordingTime(recordingTime)}
            </span>
            <button
              onClick={stopRecording}
              className="ml-auto rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500"
            >
              {tr("중지", "Stop", "停止", "停止")}
            </button>
          </div>
        )}

        <div
          className={`flex items-end gap-2 rounded-2xl border bg-gray-800 transition-colors ${
            isDirectiveMode
              ? "border-red-500/50 focus-within:border-red-400"
              : isAnnouncementMode
                ? "border-yellow-500/50 focus-within:border-yellow-400"
                : mode === "task"
                  ? "border-blue-500/50 focus-within:border-blue-400"
                  : mode === "report"
                    ? "border-emerald-500/50 focus-within:border-emerald-400"
                    : "border-gray-600 focus-within:border-blue-500"
          }`}
        >
          {/* Attachment button */}
          <button
            onClick={handleFileSelect}
            className="mb-2 ml-2 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-200"
            aria-label={tr("파일 첨부", "Attach file", "ファイル添付", "附件")}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path fillRule="evenodd" d="M18.97 3.659a2.25 2.25 0 00-3.182 0l-10.94 10.94a3.75 3.75 0 105.304 5.303l7.693-7.693a.75.75 0 011.06 1.06l-7.693 7.693a5.25 5.25 0 01-7.424-7.424l10.939-10.94a3.75 3.75 0 115.303 5.304L9.097 18.835l-.008.008-.007.007a2.25 2.25 0 01-3.182-3.182l.006-.006.007-.007 7.694-7.694a.75.75 0 011.06 1.06L7.974 16.71a.75.75 0 001.06 1.06L19.03 7.84" clipRule="evenodd" />
            </svg>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,audio/*,.pdf,.doc,.docx,.txt,.zip,.rar,.7z,.csv,.xls,.xlsx,.ppt,.pptx"
            className="hidden"
            onChange={handleFileInputChange}
          />

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
            placeholder={
              isAnnouncementMode
                ? tr(
                    "전사 공지 내용을 입력하세요...",
                    "Write an announcement...",
                    "全体告知内容を入力してください...",
                    "请输入公告内容...",
                  )
                : mode === "task"
                  ? tr(
                      "업무 지시 내용을 입력하세요...",
                      "Write a task instruction...",
                      "タスク指示内容を入力してください...",
                      "请输入任务指示内容...",
                    )
                  : mode === "report"
                    ? tr(
                        "보고 요청 내용을 입력하세요...",
                        "Write a report request...",
                        "レポート依頼内容を入力してください...",
                        "请输入报告请求内容...",
                      )
                    : selectedAgent
                      ? tr(
                          `${getAgentName(selectedAgent)}에게 메시지 보내기...`,
                          `Send a message to ${getAgentName(selectedAgent)}...`,
                          `${getAgentName(selectedAgent)}にメッセージを送る...`,
                          `向 ${getAgentName(selectedAgent)} 发送消息...`,
                        )
                      : tr(
                          "메시지를 입력하세요...",
                          "Type a message...",
                          "メッセージを入力してください...",
                          "请输入消息...",
                        )
            }
            rows={1}
            className="min-h-[44px] max-h-32 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-3 text-sm leading-relaxed text-gray-100 placeholder-gray-500 focus:outline-none"
            style={{ scrollbarWidth: "none" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
            }}
          />

          {/* Audio record button */}
          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={`mb-2 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl transition-colors ${
              isRecording
                ? "bg-red-600 text-white animate-pulse"
                : "text-gray-400 hover:bg-gray-700 hover:text-gray-200"
            }`}
            aria-label={isRecording ? tr("녹음 중지", "Stop recording", "録音停止", "停止录音") : tr("음성 녹음", "Record audio", "音声録音", "语音录音")}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path d="M8.25 4.5a3.75 3.75 0 117.5 0v8.25a3.75 3.75 0 11-7.5 0V4.5z" />
              <path d="M6 10.5a.75.75 0 01.75.75v1.5a5.25 5.25 0 1010.5 0v-1.5a.75.75 0 011.5 0v1.5a6.751 6.751 0 01-6 6.709v2.291h3a.75.75 0 010 1.5h-7.5a.75.75 0 010-1.5h3v-2.291a6.751 6.751 0 01-6-6.709v-1.5A.75.75 0 016 10.5z" />
            </svg>
          </button>

          {/* Send button */}
          <button
            onClick={handleSendWithAttachments}
            disabled={!hasContent}
            className={`mb-2 mr-2 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl transition-all ${
              hasContent
                ? isDirectiveMode
                  ? "bg-red-600 text-white hover:bg-red-500"
                  : isAnnouncementMode
                    ? "bg-yellow-500 text-gray-900 hover:bg-yellow-400"
                    : mode === "task"
                      ? "bg-blue-600 text-white hover:bg-blue-500"
                      : mode === "report"
                        ? "bg-emerald-600 text-white hover:bg-emerald-500"
                        : "bg-blue-600 text-white hover:bg-blue-500"
                : "cursor-not-allowed bg-gray-700 text-gray-600"
            }`}
            aria-label={tr("전송", "Send", "送信", "发送")}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
              <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
            </svg>
          </button>
        </div>
        <p className="mt-1.5 px-1 text-xs text-gray-600">
          {tr(
            "Enter로 전송, Shift+Enter로 줄바꿈",
            "Press Enter to send, Shift+Enter for a new line",
            "Enterで送信、Shift+Enterで改行",
            "按 Enter 发送，Shift+Enter 换行",
          )}
        </p>
      </div>
    </>
  );
}
