import { isLang, type Lang } from "../../../types/lang.ts";
import { readNonNegativeIntEnv } from "../../../db/runtime.ts";
import {
  compactMeetingPromptText,
  formatMeetingTranscriptForPrompt,
  type MeetingTranscriptLine,
} from "../meeting-prompt-utils.ts";
import type {
  AgentRow,
  MeetingReviewDecision,
  MeetingTranscriptEntry,
  OneShotRunResult,
  ReplyKind,
  RunFailureKind,
} from "./conversation-types.ts";

type LocalizedLines = {
  ko: string[];
  en: string[];
  ja: string[];
  zh: string[];
};

type CreateReplyCoreToolsDeps = {
  detectLang: (text: string) => string;
  getPreferredLanguage: () => string;
  pickL: (lines: LocalizedLines, lang: string) => string;
  prettyStreamJson: (raw: string) => string;
};

const MEETING_BUBBLE_EMPTY: LocalizedLines = {
  ko: ["의견 공유드립니다."],
  en: ["Sharing thoughts shortly."],
  ja: ["ご意見を共有します。"],
  zh: ["稍后分享意见。"],
};

const MEETING_PROMPT_TASK_CONTEXT_MAX_CHARS = Math.max(
  320,
  readNonNegativeIntEnv("MEETING_PROMPT_TASK_CONTEXT_MAX_CHARS", 1200),
);
const MEETING_TRANSCRIPT_MAX_TURNS = Math.max(4, readNonNegativeIntEnv("MEETING_TRANSCRIPT_MAX_TURNS", 20));
const MEETING_TRANSCRIPT_LINE_MAX_CHARS = Math.max(72, readNonNegativeIntEnv("MEETING_TRANSCRIPT_LINE_MAX_CHARS", 180));
const MEETING_TRANSCRIPT_TOTAL_MAX_CHARS = Math.max(
  720,
  readNonNegativeIntEnv("MEETING_TRANSCRIPT_TOTAL_MAX_CHARS", 2400),
);

export function createReplyCoreTools(deps: CreateReplyCoreToolsDeps) {
  const { detectLang, getPreferredLanguage, pickL, prettyStreamJson } = deps;

  function normalizeMeetingLang(value: unknown): Lang {
    if (isLang(value)) return value;
    const preferred = getPreferredLanguage();
    return isLang(preferred) ? preferred : "ko";
  }

  function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomDelay(minMs: number, maxMs: number): number {
    return Math.floor(minMs + Math.random() * Math.max(0, maxMs - minMs));
  }

  function getAgentDisplayName(agent: AgentRow, lang: string): string {
    return lang === "ko" ? agent.name_ko || agent.name : agent.name;
  }

  function localeInstruction(lang: string): string {
    switch (lang) {
      case "ja":
        return "Respond in Japanese.";
      case "zh":
        return "Respond in Chinese.";
      case "en":
        return "Respond in English.";
      case "ko":
        return "Respond in Korean.";
      case "pt":
        return "Responda sempre em português brasileiro (pt-BR). Nunca use coreano, japonês ou chinês.";
      default:
        return "Responda sempre em português brasileiro (pt-BR). Nunca use coreano, japonês ou chinês.";
    }
  }

  function normalizeConversationReply(raw: string, maxChars = 420, opts: { maxSentences?: number } = {}): string {
    if (!raw.trim()) return "";
    const parsed = prettyStreamJson(raw);
    let text = parsed.trim() ? parsed : raw;
    text = text
      .replace(/^\[(init|usage|mcp|thread)\][^\n]*$/gim, "")
      .replace(/^\[reasoning\]\s*/gim, "")
      .replace(/\[(tool|result|output|spawn_agent|agent_done|one-shot-error)[^\]]*\]/gi, " ")
      .replace(/^\[(copilot|antigravity)\][^\n]*$/gim, "")
      .replace(
        /\{"type"\s*:\s*"(?:step_finish|step-finish|tool_use|tool_result|thinking|reasoning|text|content)"[^\n]*\}/gm,
        " ",
      )
      .replace(/^!?\s*permission requested:.*auto-rejecting\s*$/gim, "")
      .replace(/^!?\s*execution error:.*$/gim, "")
      .replace(/^!?\s*command rejected:.*$/gim, "")
      .replace(/^!?\s*Tool execution failed:.*$/gim, "")
      .replace(/^\[(?:stdout|stderr)\]\s*/gim, "")
      .replace(/^"(.*)"$/gm, "$1")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!text) return "";

    let cleaned = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^[{}[\],]+$/.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    cleaned = collapseRepeatedSentenceCycles(cleaned);

    if (opts.maxSentences && opts.maxSentences > 0) {
      const sentences = cleaned
        .split(/(?<=[.!?。！？])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (sentences.length > opts.maxSentences) {
        cleaned = sentences.slice(0, opts.maxSentences).join(" ");
      }
    }

    if (cleaned.length > maxChars) {
      cleaned = `${cleaned.slice(0, maxChars - 1).trimEnd()}…`;
    }

    return cleaned;
  }

  function collapseRepeatedSentenceCycles(text: string): string {
    const sentences = text
      .split(/(?<=[.!?。！？])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length < 4) return text;

    const total = sentences.length;
    for (let cycleLen = 1; cycleLen <= Math.floor(total / 2); cycleLen += 1) {
      if (total % cycleLen !== 0) continue;
      const repeatCount = total / cycleLen;
      if (repeatCount < 2) continue;

      const pattern = sentences.slice(0, cycleLen);
      let repeated = true;
      for (let i = cycleLen; i < total; i += 1) {
        if (sentences[i] !== pattern[i % cycleLen]) {
          repeated = false;
          break;
        }
      }
      if (!repeated) continue;

      const collapsed = pattern.join(" ").trim();
      if (collapsed.length >= 24) return collapsed;
    }
    return text;
  }

  function isInternalWorkNarration(text: string): boolean {
    return /\b(I need to|Let me|I'll|I will|analy[sz]e|examin|inspect|check files|run command|current codebase|relevant files)\b/i.test(
      text,
    );
  }

  function fallbackTurnReply(kind: ReplyKind, lang: string, agent?: AgentRow): string {
    const name = agent ? getAgentDisplayName(agent, lang) : "";
    switch (kind) {
      case "opening":
        if (lang === "en") return `${name}: Kickoff noted. Please share concise feedback in order.`;
        if (lang === "ja") return `${name}: キックオフを開始します。順番に簡潔なフィードバックを共有してください。`;
        if (lang === "zh") return `${name}: 现在开始会议，请各位按顺序简要反馈。`;
        return `${name}: 킥오프 회의를 시작합니다. 순서대로 핵심 피드백을 간단히 공유해주세요.`;
      case "feedback":
        if (lang === "en")
          return `${name}: We have identified key gaps and a top-priority validation item before execution.`;
        if (lang === "ja") return `${name}: 着手前の補完項目と最優先の検証課題を確認しました。`;
        if (lang === "zh") return `${name}: 已确认执行前的补充项与最高优先验证课题。`;
        return `${name}: 착수 전 보완 항목과 최우선 검증 과제를 확인했습니다.`;
      case "summary":
        if (lang === "en")
          return `${name}: I will consolidate all leader feedback and proceed with the agreed next step.`;
        if (lang === "ja") return `${name}: 各チームリーダーの意見を統合し、合意した次のステップへ進めます。`;
        if (lang === "zh") return `${name}: 我将汇总各负责人意见，并按约定进入下一步。`;
        return `${name}: 각 팀장 의견을 취합해 합의된 다음 단계로 진행하겠습니다.`;
      case "approval":
        if (lang === "en")
          return `${name}: Decision noted. We will proceed according to the current meeting conclusion.`;
        if (lang === "ja") return `${name}: 本会議の結論に従って進行します。`;
        if (lang === "zh") return `${name}: 已确认决策，将按本轮会议结论执行。`;
        return `${name}: 본 회의 결론에 따라 진행하겠습니다.`;
      case "direct":
      default:
        if (lang === "en") return `${name}: Acknowledged. Proceeding with the requested direction.`;
        if (lang === "ja") return `${name}: 承知しました。ご指示の方向で進めます。`;
        if (lang === "zh") return `${name}: 收到，将按您的指示推进。`;
        return `${name}: 확인했습니다. 요청하신 방향으로 진행하겠습니다.`;
    }
  }

  function buildAgentReplyText(
    lang: string,
    agent: AgentRow | undefined,
    messages: { ko: string; en: string; ja: string; zh: string },
  ): string {
    const body = lang === "en" ? messages.en : lang === "ja" ? messages.ja : lang === "zh" ? messages.zh : messages.ko;
    const name = agent ? getAgentDisplayName(agent, lang) : "";
    return name ? `${name}: ${body}` : body;
  }

  function clipFailureDetail(value: string, max = 180): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 1).trimEnd()}…`;
  }

  function extractRunFailureDetail(rawText: string, runError?: string): string {
    const candidates: string[] = [];
    if (runError && runError.trim()) candidates.push(runError.trim());
    for (const line of rawText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      candidates.push(trimmed);
    }
    for (const candidate of candidates) {
      const line = candidate
        .replace(/^\[(?:one-shot-error|tool-error)\]\s*/i, "")
        .replace(/^error:\s*/i, "")
        .trim();
      if (!line) continue;
      if (line.startsWith("{")) continue;
      if (/^(permission requested:|auto-rejecting)/i.test(line)) continue;
      if (/^(type=|sessionid=|timestamp=)/i.test(line)) continue;
      return clipFailureDetail(line);
    }
    return "";
  }

  function detectRunFailure(rawText: string, runError?: string): RunFailureKind | null {
    const source = [runError || "", rawText || ""].filter(Boolean).join("\n");
    if (!source.trim()) return null;
    if (
      /auto-rejecting|permission.*rejected|rejected permission|external_directory|user rejected permission/i.test(
        source,
      )
    )
      return "permission";
    if (/modified since it was last read|read the file again before modifying/i.test(source)) return "stale_file";
    if (/"type"\s*:\s*"(?:step_finish|step-finish)".*"reason"\s*:\s*"tool-calls"/i.test(source))
      return "tool_calls_only";
    if (/timeout after|timed out|request timed out/i.test(source)) return "timeout";
    if (runError || /\[(?:one-shot-error|tool-error)\]/i.test(source) || /^error:/im.test(source)) return "generic";
    return null;
  }

  function buildRunFailureReply(kind: RunFailureKind, lang: string, agent?: AgentRow, detail = ""): string {
    if (kind === "permission") {
      return buildAgentReplyText(lang, agent, {
        ko: "파일 접근 권한에 의해 작업이 차단되었습니다. 프로젝트 디렉터리 설정을 확인해주세요.",
        en: "The requested operation was blocked by a file-access permission. Please check the project directory settings.",
        ja: "ファイルアクセス権限により操作がブロックされました。プロジェクトディレクトリ設定を確認してください。",
        zh: "操作因文件访问权限被阻止，请检查项目目录设置。",
      });
    }
    if (kind === "stale_file") {
      return buildAgentReplyText(lang, agent, {
        ko: "파일이 읽은 뒤 변경되어 작업이 중단되었습니다. 파일을 다시 읽고 재시도해주세요.",
        en: "The file changed after it was read, so the operation was stopped. Please re-read the file and retry.",
        ja: "読み取り後にファイルが変更されたため、処理が停止しました。再読込して再試行してください。",
        zh: "文件在读取后被修改，操作已中止。请重新读取该文件后再试。",
      });
    }
    if (kind === "tool_calls_only") {
      return buildAgentReplyText(lang, agent, {
        ko: "도구 호출 단계에서 종료되어 최종 답변이 생성되지 않았습니다. 다시 시도해주세요.",
        en: "The run ended at tool-calls without producing a final reply. Please retry.",
        ja: "ツール呼び出し段階で終了し、最終回答が生成されませんでした。再試行してください。",
        zh: "执行在工具调用阶段结束，未生成最终回复。请重试。",
      });
    }
    if (kind === "timeout") {
      return buildAgentReplyText(lang, agent, {
        ko: "응답 생성 시간이 초과되어 작업이 중단되었습니다. 잠시 후 다시 시도해주세요.",
        en: "Response generation timed out, so the run was stopped. Please try again shortly.",
        ja: "応答生成がタイムアウトしたため処理を停止しました。しばらくして再試行してください。",
        zh: "回复生成超时，任务已中止。请稍后重试。",
      });
    }
    const suffix = detail ? ` (${detail})` : "";
    return buildAgentReplyText(lang, agent, {
      ko: `CLI 실행 중 오류가 발생했습니다${suffix}.`,
      en: `CLI execution failed${suffix}.`,
      ja: `CLI 実行中にエラーが発生しました${suffix}。`,
      zh: `CLI 执行失败${suffix}。`,
    });
  }

  function chooseSafeReply(run: OneShotRunResult, lang: string, kind: ReplyKind, agent?: AgentRow): string {
    const maxReplyChars = kind === "direct" ? 12000 : 2000;
    const rawText = run.text || "";
    const failureKind = detectRunFailure(rawText, run.error);
    if (failureKind) {
      const detail = failureKind === "generic" ? extractRunFailureDetail(rawText, run.error) : "";
      return buildRunFailureReply(failureKind, lang, agent, detail);
    }
    const cleaned = normalizeConversationReply(rawText, maxReplyChars, { maxSentences: 0 });
    if (!cleaned) return fallbackTurnReply(kind, lang, agent);
    if (/timeout after|CLI 응답 생성에 실패|response failed|one-shot-error/i.test(cleaned)) {
      return fallbackTurnReply(kind, lang, agent);
    }
    if (isInternalWorkNarration(cleaned)) return fallbackTurnReply(kind, lang, agent);
    if ((lang === "ko" || lang === "ja" || lang === "zh") && detectLang(cleaned) === "en" && cleaned.length > 20) {
      return fallbackTurnReply(kind, lang, agent);
    }
    return cleaned;
  }

  function compactForMeetingPrompt(text: string, maxChars: number): string {
    return compactMeetingPromptText(text, maxChars);
  }

  function summarizeForMeetingBubble(
    text: string,
    maxChars = 96,
    lang: Lang = normalizeMeetingLang(getPreferredLanguage()),
  ): string {
    const cleaned = normalizeConversationReply(text, maxChars + 24)
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return pickL(MEETING_BUBBLE_EMPTY, lang);
    if (cleaned.length <= maxChars) return cleaned;
    return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`;
  }

  function isMvpDeferralSignal(text: string): boolean {
    return /mvp|범위\s*초과|실환경|프로덕션|production|post[-\s]?merge|post[-\s]?release|안정화\s*단계|stabilization|모니터링|monitoring|sla|체크리스트|checklist|문서화|runbook|후속\s*(개선|처리|모니터링)|defer|deferred|later\s*phase|다음\s*단계|배포\s*후/i.test(
      text,
    );
  }

  function isHardBlockSignal(text: string): boolean {
    return /최종\s*승인\s*불가|배포\s*불가|절대\s*불가|중단|즉시\s*중단|반려|cannot\s+(approve|ship|release)|must\s+fix\s+before|hard\s+blocker|critical\s+blocker|p0|data\s+loss|security\s+incident|integrity\s+broken|audit\s*fail|build\s*fail|무결성\s*(훼손|깨짐)|데이터\s*손실|보안\s*사고|치명/i.test(
      text,
    );
  }

  function hasApprovalAgreementSignal(text: string): boolean {
    return /승인|approve|approved|동의|agree|agreed|lgtm|go\s+ahead|merge\s+approve|병합\s*승인|전환\s*동의|조건부\s*승인/i.test(
      text,
    );
  }

  function isDeferrableReviewHold(text: string): boolean {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) return false;
    if (!isMvpDeferralSignal(cleaned)) return false;
    if (isHardBlockSignal(cleaned)) return false;
    return true;
  }

  function classifyMeetingReviewDecision(text: string): MeetingReviewDecision {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) return "reviewing";
    const hasApprovalAgreement = hasApprovalAgreementSignal(cleaned);
    const hasMvpDeferral = isMvpDeferralSignal(cleaned);
    const hasHardBlock = isHardBlockSignal(cleaned);
    const hasApprovalSignal =
      /(승인|통과|문제없|진행.?가능|배포.?가능|approve|approved|lgtm|ship\s+it|go\s+ahead|承認|批准|通过|可发布)/i.test(
        cleaned,
      );
    const hasNoRiskSignal =
      /(리스크\s*(없|없음|없습니다|없는|없이)|위험\s*(없|없음|없습니다|없는|없이)|문제\s*없|이슈\s*없|no\s+risk|without\s+risk|risk[-\s]?free|no\s+issue|no\s+blocker|リスク(は)?(ありません|なし|無し)|問題ありません|无风险|没有风险|無風險|无问题)/i.test(
        cleaned,
      );
    const hasConditionalOrHoldSignal =
      /(조건부|보완|수정|보류|리스크|미흡|미완|추가.?필요|재검토|중단|불가|hold|revise|revision|changes?\s+requested|required|pending|risk|block|missing|incomplete|not\s+ready|保留|修正|风险|补充|未完成|暂缓|差し戻し)/i.test(
        cleaned,
      );

    if (hasApprovalSignal && hasNoRiskSignal) return "approved";
    if ((hasApprovalAgreement || hasApprovalSignal) && hasMvpDeferral && !hasHardBlock) return "approved";
    if (hasConditionalOrHoldSignal) {
      if ((hasApprovalAgreement || hasApprovalSignal) && hasMvpDeferral && !hasHardBlock) return "approved";
      return "hold";
    }
    if (hasApprovalSignal || hasNoRiskSignal || hasApprovalAgreement) return "approved";
    return "reviewing";
  }

  function wantsReviewRevision(content: string): boolean {
    return classifyMeetingReviewDecision(content) === "hold";
  }

  function findLatestTranscriptContentByAgent(transcript: MeetingTranscriptEntry[], agentId: string): string {
    for (let i = transcript.length - 1; i >= 0; i -= 1) {
      const row = transcript[i];
      if (row.speaker_agent_id === agentId) return row.content;
    }
    return "";
  }

  function compactTaskDescriptionForMeeting(taskDescription: string | null): string {
    if (!taskDescription) return "";
    const marker = "[PROJECT MEMO]";
    const markerIdx = taskDescription.indexOf(marker);
    const base = markerIdx >= 0 ? taskDescription.slice(0, markerIdx) : taskDescription;
    return compactForMeetingPrompt(base, MEETING_PROMPT_TASK_CONTEXT_MAX_CHARS);
  }

  function formatMeetingTranscript(
    transcript: MeetingTranscriptEntry[],
    lang: Lang = normalizeMeetingLang(getPreferredLanguage()),
  ): string {
    const lines: MeetingTranscriptLine[] = transcript.map((row) => ({
      speaker: row.speaker,
      department: row.department,
      role: row.role,
      content: row.content,
    }));

    return formatMeetingTranscriptForPrompt(lines, {
      maxTurns: MEETING_TRANSCRIPT_MAX_TURNS,
      maxLineChars: MEETING_TRANSCRIPT_LINE_MAX_CHARS,
      maxTotalChars: MEETING_TRANSCRIPT_TOTAL_MAX_CHARS,
      summarize: (text, maxChars) => summarizeForMeetingBubble(text, maxChars, lang),
    });
  }

  return {
    normalizeMeetingLang,
    sleepMs,
    randomDelay,
    getAgentDisplayName,
    localeInstruction,
    normalizeConversationReply,
    isInternalWorkNarration,
    fallbackTurnReply,
    chooseSafeReply,
    summarizeForMeetingBubble,
    isMvpDeferralSignal,
    isHardBlockSignal,
    hasApprovalAgreementSignal,
    isDeferrableReviewHold,
    classifyMeetingReviewDecision,
    wantsReviewRevision,
    findLatestTranscriptContentByAgent,
    compactTaskDescriptionForMeeting,
    formatMeetingTranscript,
  };
}
