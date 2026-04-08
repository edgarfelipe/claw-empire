import type { SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import multer from "multer";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { AgentRow, StoredMessage } from "../../shared/types.ts";

const UPLOADS_DIR = join(process.cwd(), "uploads");
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname);
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

function classifyFileType(mime: string): "image" | "audio" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}


type ChatMessageRouteCtx = Pick<RuntimeContext, "app" | "db" | "broadcast">;

type ChatMessageRouteDeps = {
  IdempotencyConflictError: RuntimeContext["IdempotencyConflictError"];
  StorageBusyError: RuntimeContext["StorageBusyError"];
  firstQueryValue: RuntimeContext["firstQueryValue"];
  resolveMessageIdempotencyKey: RuntimeContext["resolveMessageIdempotencyKey"];
  recordMessageIngressAuditOr503: RuntimeContext["recordMessageIngressAuditOr503"];
  insertMessageWithIdempotency: RuntimeContext["insertMessageWithIdempotency"];
  recordAcceptedIngressAuditOrRollback: RuntimeContext["recordAcceptedIngressAuditOrRollback"];
  normalizeTextField: RuntimeContext["normalizeTextField"];
  handleReportRequest: RuntimeContext["handleReportRequest"];
  scheduleAgentReply: RuntimeContext["scheduleAgentReply"];
  detectMentions: RuntimeContext["detectMentions"];
  resolveLang: RuntimeContext["resolveLang"];
  handleMentionDelegation: RuntimeContext["handleMentionDelegation"];
};

export function registerChatMessageRoutes(ctx: ChatMessageRouteCtx, deps: ChatMessageRouteDeps): void {
  const { app, db, broadcast } = ctx;
  const {
    IdempotencyConflictError,
    StorageBusyError,
    firstQueryValue,
    resolveMessageIdempotencyKey,
    recordMessageIngressAuditOr503,
    insertMessageWithIdempotency,
    recordAcceptedIngressAuditOrRollback,
    normalizeTextField,
    handleReportRequest,
    scheduleAgentReply,
    detectMentions,
    resolveLang,
    handleMentionDelegation,
  } = deps;

  app.get("/api/messages", (req, res) => {
    const receiverType = firstQueryValue(req.query.receiver_type);
    const receiverId = firstQueryValue(req.query.receiver_id);
    const limitRaw = firstQueryValue(req.query.limit);
    const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 500);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (receiverType && receiverId) {
      // Conversation with a specific agent: show messages TO and FROM that agent
      conditions.push(
        "((receiver_type = ? AND receiver_id = ?) OR (sender_type = 'agent' AND sender_id = ?) OR receiver_type = 'all')",
      );
      params.push(receiverType, receiverId, receiverId);
    } else if (receiverType) {
      conditions.push("receiver_type = ?");
      params.push(receiverType);
    } else if (receiverId) {
      conditions.push("(receiver_id = ? OR receiver_type = 'all')");
      params.push(receiverId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const messages = db
      .prepare(
        `
    SELECT m.*,
      a.name AS sender_name,
      a.avatar_emoji AS sender_avatar
    FROM messages m
    LEFT JOIN agents a ON m.sender_type = 'agent' AND m.sender_id = a.id
    ${where}
    ORDER BY m.created_at DESC
    LIMIT ?
  `,
      )
      .all(...(params as SQLInputValue[])) as Array<Record<string, unknown>>;

    // Attach attachments to each message
    const enriched = messages.map((msg) => {
      const atts = db
        .prepare(
          `SELECT id, file_name, file_type, mime_type, file_size, thumbnail_path, duration_ms, width, height
           FROM message_attachments WHERE message_id = ? ORDER BY created_at ASC`,
        )
        .all(msg.id as string) as Array<Record<string, unknown>>;

      if (atts.length > 0) {
        (msg as Record<string, unknown>).attachments = atts.map((a) => ({
          id: a.id,
          file_name: a.file_name,
          file_type: a.file_type,
          mime_type: a.mime_type,
          file_size: a.file_size,
          url: `/api/messages/files/${a.id}`,
          thumbnail_url: a.thumbnail_path ? `/api/messages/files/${a.id}?thumb=1` : undefined,
          duration_ms: a.duration_ms ?? undefined,
          width: a.width ?? undefined,
          height: a.height ?? undefined,
        }));
      }
      return msg;
    });

    res.json({ messages: enriched.reverse() }); // return in chronological order
  });

  app.post("/api/messages", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey = resolveMessageIdempotencyKey(req, body, "api.messages");
    const content = body.content;
    if (!content || typeof content !== "string") {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/messages",
          req,
          body,
          idempotencyKey,
          outcome: "validation_error",
          statusCode: 400,
          detail: "content_required",
        })
      )
        return;
      return res.status(400).json({ error: "content_required" });
    }

    const senderType = typeof body.sender_type === "string" ? body.sender_type : "ceo";
    const senderId = typeof body.sender_id === "string" ? body.sender_id : null;
    const receiverType = typeof body.receiver_type === "string" ? body.receiver_type : "all";
    const receiverId = typeof body.receiver_id === "string" ? body.receiver_id : null;
    const messageType = typeof body.message_type === "string" ? body.message_type : "chat";
    const taskId = typeof body.task_id === "string" ? body.task_id : null;
    const projectId = normalizeTextField(body.project_id);
    const projectPath = normalizeTextField(body.project_path);
    const projectContext = normalizeTextField(body.project_context);

    let storedMessage: StoredMessage;
    let created: boolean;
    try {
      ({ message: storedMessage, created } = await insertMessageWithIdempotency({
        senderType,
        senderId,
        receiverType,
        receiverId,
        content,
        messageType,
        taskId,
        idempotencyKey,
      }));
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        const conflictErr = err as { key: string };
        if (
          !recordMessageIngressAuditOr503(res, {
            endpoint: "/api/messages",
            req,
            body,
            idempotencyKey,
            outcome: "idempotency_conflict",
            statusCode: 409,
            detail: "payload_mismatch",
          })
        )
          return;
        return res.status(409).json({ error: "idempotency_conflict", idempotency_key: conflictErr.key });
      }
      if (err instanceof StorageBusyError) {
        const busyErr = err as { operation: string; attempts: number };
        if (
          !recordMessageIngressAuditOr503(res, {
            endpoint: "/api/messages",
            req,
            body,
            idempotencyKey,
            outcome: "storage_busy",
            statusCode: 503,
            detail: `operation=${busyErr.operation}, attempts=${busyErr.attempts}`,
          })
        )
          return;
        return res.status(503).json({ error: "storage_busy", retryable: true, operation: busyErr.operation });
      }
      throw err;
    }

    const msg = { ...storedMessage } as StoredMessage & { attachments?: unknown[] };

    // Link attachments if provided
    const attachmentIds = Array.isArray(body.attachment_ids) ? body.attachment_ids as string[] : [];
    if (attachmentIds.length > 0 && storedMessage.id) {
      for (const attId of attachmentIds) {
        try {
          db.exec(`UPDATE message_attachments SET message_id = '${storedMessage.id}' WHERE id = '${attId}'`);
        } catch { /* ignore */ }
      }
      // Fetch attachments to include in response
      try {
        const atts = db.prepare(
          `SELECT id, file_name, file_type, mime_type, file_size, storage_path, thumbnail_path, duration_ms, width, height FROM message_attachments WHERE message_id = ?`
        ).all(storedMessage.id) as Array<Record<string, unknown>>;
        msg.attachments = atts.map((a) => ({
          id: a.id,
          file_name: a.file_name,
          file_type: a.file_type,
          mime_type: a.mime_type,
          file_size: a.file_size,
          url: `/api/messages/files/${a.id}`,
          thumbnail_url: a.thumbnail_path ? `/api/messages/files/${a.id}?thumb=1` : undefined,
          duration_ms: a.duration_ms,
          width: a.width,
          height: a.height,
        }));
      } catch { /* ignore */ }
    }

    if (!created) {
      if (
        !recordMessageIngressAuditOr503(res, {
          endpoint: "/api/messages",
          req,
          body,
          idempotencyKey,
          outcome: "duplicate",
          statusCode: 200,
          messageId: msg.id,
          detail: "idempotent_replay",
        })
      )
        return;
      return res.json({ ok: true, message: msg, duplicate: true });
    }

    if (
      !(await recordAcceptedIngressAuditOrRollback(
        res,
        {
          endpoint: "/api/messages",
          req,
          body,
          idempotencyKey,
          outcome: "accepted",
          statusCode: 200,
          detail: "created",
        },
        msg.id,
      ))
    )
      return;
    broadcast("new_message", msg);

    // Schedule agent auto-reply when CEO messages an agent
    if (senderType === "ceo" && receiverType === "agent" && receiverId) {
      if (messageType === "report") {
        const handled = handleReportRequest(receiverId, content);
        if (!handled) {
          scheduleAgentReply(receiverId, content, messageType, {
            projectId,
            projectPath,
            projectContext,
          });
        }
        return res.json({ ok: true, message: msg });
      }

      scheduleAgentReply(receiverId, content, messageType, {
        projectId,
        projectPath,
        projectContext,
      });

      // Check for @mentions to other departments/agents
      const mentions = detectMentions(content);
      if (mentions.deptIds.length > 0 || mentions.agentIds.length > 0) {
        const senderAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(receiverId) as AgentRow | undefined;
        if (senderAgent) {
          const lang = resolveLang(content);
          const mentionDelay = 4000 + Math.random() * 2000; // After the main delegation starts
          setTimeout(() => {
            // Handle department mentions
            for (const deptId of mentions.deptIds) {
              if (deptId === senderAgent.department_id) continue; // Skip own department
              handleMentionDelegation(senderAgent, deptId, content, lang);
            }
            // Handle agent mentions — find their department and delegate there
            for (const agentId of mentions.agentIds) {
              const mentioned = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
              if (mentioned && mentioned.department_id && mentioned.department_id !== senderAgent.department_id) {
                if (!mentions.deptIds.includes(mentioned.department_id)) {
                  handleMentionDelegation(senderAgent, mentioned.department_id, content, lang);
                }
              }
            }
          }, mentionDelay);
        }
      }
    }

    res.json({ ok: true, message: msg });
  });

  // Delete conversation messages
  app.delete("/api/messages", (req, res) => {
    const agentId = firstQueryValue(req.query.agent_id);
    const scope = firstQueryValue(req.query.scope) || "conversation"; // "conversation" or "all"

    if (scope === "all") {
      // Delete all messages (announcements + conversations)
      const result = db.prepare("DELETE FROM messages").run();
      broadcast("messages_cleared", { scope: "all" });
      return res.json({ ok: true, deleted: result.changes });
    }

    if (agentId) {
      // Delete messages for a specific agent conversation + announcements shown in that chat
      const result = db
        .prepare(
          `DELETE FROM messages WHERE
        (sender_type = 'ceo' AND receiver_type = 'agent' AND receiver_id = ?)
        OR (sender_type = 'agent' AND sender_id = ?)
        OR receiver_type = 'all'
        OR message_type = 'announcement'`,
        )
        .run(agentId, agentId);
      broadcast("messages_cleared", { scope: "agent", agent_id: agentId });
      return res.json({ ok: true, deleted: result.changes });
    }

    // Delete only announcements/broadcasts
    const result = db
      .prepare("DELETE FROM messages WHERE receiver_type = 'all' OR message_type = 'announcement'")
      .run();
    broadcast("messages_cleared", { scope: "announcements" });
    res.json({ ok: true, deleted: result.changes });
  });

  // File upload endpoint
  app.post("/api/messages/upload", upload.array("files", 10), async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        return res.status(400).json({ error: "no_files" });
      }

      const attachments: Array<{
        id: string;
        file_name: string;
        file_type: string;
        mime_type: string;
        file_size: number;
        url: string;
        thumbnail_url?: string;
        width?: number;
        height?: number;
      }> = [];

      for (const file of files) {
        const id = randomUUID();
        const fileType = classifyFileType(file.mimetype);
        let width: number | undefined;
        let height: number | undefined;
        let thumbnailPath: string | undefined;

        // Try to get image dimensions and generate thumbnail with sharp
        if (fileType === "image") {
          try {
            const sharp = (await import("sharp")).default;
            const metadata = await sharp(file.path).metadata();
            width = metadata.width;
            height = metadata.height;

            // Generate thumbnail (max 300px wide)
            const thumbName = `thumb_${file.filename}`;
            thumbnailPath = join(UPLOADS_DIR, thumbName);
            await sharp(file.path)
              .resize(300, 300, { fit: "inside", withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toFile(thumbnailPath);
          } catch {
            // sharp might not be available or image might be corrupt - proceed without thumbnail
          }
        }

        db.prepare(
          `INSERT INTO message_attachments (id, message_id, file_name, file_type, mime_type, file_size, storage_path, thumbnail_path, width, height)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          "", // message_id will be updated when message is sent
          file.originalname,
          fileType,
          file.mimetype,
          file.size,
          file.path,
          thumbnailPath ?? null,
          width ?? null,
          height ?? null,
        );

        attachments.push({
          id,
          file_name: file.originalname,
          file_type: fileType,
          mime_type: file.mimetype,
          file_size: file.size,
          url: `/api/messages/files/${id}`,
          thumbnail_url: thumbnailPath ? `/api/messages/files/${id}?thumb=1` : undefined,
          width,
          height,
        });
      }

      res.json({ ok: true, attachments });
    } catch (err) {
      console.error("Upload error:", err);
      res.status(500).json({ error: "upload_failed" });
    }
  });

  // Link attachments to a message
  app.post("/api/messages/attachments/link", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const messageId = typeof body.message_id === "string" ? body.message_id : null;
    const attachmentIds = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];

    if (!messageId || attachmentIds.length === 0) {
      return res.status(400).json({ error: "message_id_and_attachment_ids_required" });
    }

    for (const aid of attachmentIds) {
      if (typeof aid === "string") {
        db.prepare("UPDATE message_attachments SET message_id = ? WHERE id = ?").run(messageId, aid);
      }
    }

    res.json({ ok: true });
  });

  // Serve uploaded files
  app.get("/api/messages/files/:id", (req, res) => {
    const { id } = req.params;
    const isThumb = req.query.thumb === "1";

    const row = db.prepare("SELECT * FROM message_attachments WHERE id = ?").get(id) as
      | { storage_path: string; thumbnail_path: string | null; mime_type: string; file_name: string }
      | undefined;

    if (!row) {
      return res.status(404).json({ error: "not_found" });
    }

    const filePath = isThumb && row.thumbnail_path ? row.thumbnail_path : row.storage_path;

    if (!existsSync(filePath)) {
      return res.status(404).json({ error: "file_not_found" });
    }

    const stat = statSync(filePath);
    const mimeType = isThumb ? "image/jpeg" : row.mime_type;

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(row.file_name)}"`);
    res.setHeader("Cache-Control", "public, max-age=86400");

    createReadStream(filePath).pipe(res);
  });
}
