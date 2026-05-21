# Messaging UX – API and integration

This document describes the upgraded messaging API and how to integrate it in the frontend without breaking existing behavior.

## Existing behavior (unchanged)

- **Project-aware conversations**: `GET /api/v1/messages/conversations` returns projects with last message and unread count. `GET /api/v1/messages?project_id=<id>` returns messages for that project.
- **Read receipts**: Messages include `delivered_at` and `is_read`. Use `MessageReceipt` with `delivered={delivered_at}` and `read={is_read}` for ✓ Sent / ✓✓ Delivered / ✓✓ Read (blue).
- **Typing indicators**: Socket events `typing_start` and `typing_stop` with `{ userId, projectId }`. Emit when the user focuses the input and types; subscribe to show “X is typing…”.
- **File sharing**: Attachments in `message.attachments`; use protected URL `/api/v1/files/chat/:attachmentId` for download. Preview images/PDFs in the UI as needed.

## New endpoints

### Search

- **GET** `/api/v1/messages/search?project_id=<uuid>&q=<string>`  
  Returns messages in the project whose text matches `q` (max 50). Requires auth and project access.

### Reactions

- **POST** `/api/v1/messages/:id/reactions`  
  Body: `{ "emoji": "👍" }` (max 32 chars). Toggle: add if not present, remove if present. Returns `{ action: "added"|"removed", emoji }`.  
  Socket: `message:reaction_added` / `message:reaction_removed` with `{ messageId, userId, emoji }`.

### Pinned messages

- **GET** `/api/v1/messages/pinned?project_id=<uuid>`  
  Returns pinned messages for the project (with sender and text).
- **POST** `/api/v1/messages/:id/pin`  
  Pin a message (idempotent). Socket: `message:pinned` with `{ messageId, projectId }`.
- **DELETE** `/api/v1/messages/:id/pin`  
  Unpin. Socket: `message:unpinned` with `{ messageId }`.

### Export

- **GET** `/api/v1/messages/export?project_id=<uuid>&format=json`  
  Returns `{ project_id, messages: [...], exported_at }`. Each message includes `attachments`. Use for “Export conversation”.

### Activity timeline

- **GET** `/api/v1/messages/activity?project_id=<uuid>`  
  Returns recent `project_activity` rows (type, reference_id, actor_id, actor_name, details, created_at). Use for a “Project activity” or “Timeline” panel.

### Escalation

- **POST** `/api/v1/messages/escalate`  
  Body: `{ "project_id": "<uuid>", "message_id": "<uuid> (optional)", "reason": "optional text" }`. Creates an escalation (status `open`). Admins get in-app notification; socket `escalation:new`.
- **PATCH** `/api/v1/messages/escalations/:id`  
  Body: `{ "status": "acknowledged"|"resolved" }`. Admin only. Socket: `escalation:updated`.

### AI assistant

- **GET** `/api/v1/messages/ai-assistant?project_id=<uuid>&action=summarize|weekly_report|pending_actions`  
  Optional: `from_date`, `to_date` (YYYY-MM-DD). Returns `{ action, project_id, from_date, to_date, text, generated_at }`.
  - **summarize**: Short summary of recent messages.
  - **weekly_report**: Message count, milestone updates, media uploads, latest milestones.
  - **pending_actions**: Open escalations, incomplete milestones, message count in period.

## Message list payload (GET /messages)

Each message now includes:

- `attachments`: unchanged.
- `reactions`: `[{ user_id, emoji }, ...]`.
- `pinned`: boolean (whether this message is pinned in the project).

Use these to render reactions under each message and a pin icon; update reactions/pinned from socket events when received.

## Project activity

When a message is sent (POST /send or POST /), the backend inserts a row into `project_activity` with `activity_type: 'message'` and optional `details` (e.g. snippet, has_attachments). Other events (e.g. media upload, milestone) can be added to the same table for a unified timeline.

## Database (new tables)

- **message_reactions**: message_id, user_id, emoji, created_at (unique per message/user/emoji).
- **pinned_messages**: project_id, message_id, pinned_by, created_at.
- **project_activity**: project_id, activity_type, reference_id, actor_id, details (JSON), created_at.
- **escalations**: project_id, message_id, raised_by, reason, status (open|acknowledged|resolved), resolved_at, resolved_by.

SQLite and PostgreSQL migrations add these tables; run `npm run db:migrate` after pulling.

## Frontend checklist (without breaking existing flows)

1. **Read receipts**: Keep using `MessageReceipt` with `delivered_at` and `is_read`; ensure the message list passes them from the API.
2. **Typing**: On input focus/change, emit `typing_start` with `projectId` (and optionally `recipientId`); on blur or after a short idle, emit `typing_stop`. Subscribe to `typing_start`/`typing_stop` and show a “X is typing…” bar above the composer.
3. **Reactions**: On long-press or hover, show an emoji picker (e.g. 👍❤️😅); on choose, POST `/messages/:id/reactions` with `{ emoji }`. Render `message.reactions` under each bubble; on `message:reaction_added`/`removed`, update local state.
4. **Pinned**: “Pinned messages” panel or section that fetches `GET /messages/pinned?project_id=`. On message context menu, “Pin” → POST `/:id/pin`, “Unpin” → DELETE `/:id/pin`. Reflect `message.pinned` and socket `message:pinned`/`unpinned`.
5. **Search**: Search bar above the thread; on submit, GET `/messages/search?project_id=&q=`; show results in a modal or inline with jump-to-message.
6. **Export**: “Export conversation” button → GET `/messages/export?project_id=` → download as JSON or trigger a client-side format (e.g. text file).
7. **Activity**: “Activity” or “Timeline” tab/panel → GET `/messages/activity?project_id=`; render list with type, actor, date, and details.
8. **Escalation**: “Escalation” or “Need help?” button → modal with optional reason → POST `/messages/escalate`; show success toast.
9. **AI assistant**: Collapsible “AI assistant” panel with three actions: Summarize, Weekly report, Pending actions. Call GET `/messages/ai-assistant?project_id=&action=...` and display the returned `text`.
10. **Mobile/tablet**: Use existing responsive layout (e.g. conversation list full-screen on small, thread on larger). Ensure touch targets (reaction, pin, export, escalate) are large enough and that the composer and panels work in narrow viewports.

## Tests

- **Backend**: `backend/tests/integration/api.test.js` includes a “Messaging workflows” describe block that asserts 401 for unauthenticated requests to search, pinned, export, activity, escalate, and ai-assistant, and 400 for invalid ai-assistant action.
- Run: `npm run test:integration` (with backend running) or run the full test suite.
