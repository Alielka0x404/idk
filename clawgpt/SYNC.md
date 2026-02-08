# ClawGPT Memory Sync Protocol

ClawGPT syncs conversations to the filesystem via the OpenClaw agent, enabling the agent to recall conversations from any device.

## How It Works

1. **User chats** in ClawGPT (desktop or mobile)
2. **Desktop sends sync message** to OpenClaw agent after each exchange
3. **Agent writes** to `~/clawgpt/clawgpt-memory/YYYY-MM-DD.jsonl`
4. **Agent responds** with `NO_REPLY` (silent - user sees nothing)

Mobile messages sync to desktop via relay, then desktop syncs everything to the agent.

## Message Format

ClawGPT sends a message starting with `[CLAWGPT-SYNC]` followed by JSON:

```
[CLAWGPT-SYNC]
{"messages":[...],"deviceId":"...","syncedAt":1707123456789}
```

### Message Schema

```json
{
  "messages": [
    {
      "id": "chatId-messageIndex",
      "chatId": "abc123",
      "chatTitle": "Chat title or first few words",
      "role": "user" | "assistant",
      "content": "Message text",
      "timestamp": 1707123456789
    }
  ],
  "deviceId": "desktop-xyz" | "phone-abc",
  "syncedAt": 1707123456789
}
```

## File Structure

```
~/clawgpt/clawgpt-memory/
  2026-02-04.jsonl
  2026-02-05.jsonl
  ...
```

Each line in a JSONL file is one message:
```json
{"id":"chat1-0","chatId":"chat1","chatTitle":"Hello","role":"user","content":"Hi","timestamp":1707123456789,"deviceId":"desktop"}
```

## Agent Handling

When the OpenClaw agent receives a `[CLAWGPT-SYNC]` message:

1. Parse the JSON after the prefix
2. Group messages by date (from timestamp)
3. Append to `~/clawgpt/clawgpt-memory/YYYY-MM-DD.jsonl`
4. Deduplicate by message ID (don't write if ID already exists)
5. Respond with `NO_REPLY`

## Sync Triggers

Desktop sends sync messages:
- After receiving each assistant response
- When phone syncs new messages via relay
- On app startup (full sync of any unsynced messages)

## Device IDs

- Desktop generates: `desktop-{random}`
- Mobile generates: `phone-{random}`
- Stored in localStorage, persistent across sessions

## Privacy

- All data stays local (no cloud)
- Sync only happens through user's own OpenClaw gateway
- Agent writes to user's local filesystem
