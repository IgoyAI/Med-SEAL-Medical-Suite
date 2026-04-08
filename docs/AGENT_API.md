# Med-SEAL Agent API — Mobile App Integration Guide

## Connection Details

| Setting | Value |
|---------|-------|
| **Base URL** | `https://medseal-agent.ngrok-free.dev` |
| **Agent API** | `https://medseal-agent.ngrok-free.dev` (Med-SEAL orchestrator) |
| **FHIR Server** | `https://medseal-fhir.ngrok-free.dev` |
| **vLLM (raw LLM)** | `https://medseal-llm.ngrok-free.dev` |
| **Auth** | None required (no API key) |
| **Content-Type** | `application/json` |

---

## Quick Start

```bash
# 1. Create a session
POST /sessions
# Returns: { "session_id": "abc123...", "created_at": "..." }

# 2. Send a message
POST /sessions/{session_id}/messages
Body: { "message": "What is diabetes?", "patient_id": "patient-uuid" }

# 3. Get response with sources + thinking timeline
```

---

## Endpoints

### 1. Create Session

```
POST /sessions
```

Creates a new conversation session. Call this once per conversation.

**Response:**
```json
{
  "session_id": "6b0c422be86a4c2f8481339ac982a942",
  "created_at": "2026-03-16T01:50:15.372398+00:00"
}
```

---

### 2. Send Message (Synchronous)

```
POST /sessions/{session_id}/messages
```

Send a patient message and get the full agent response.

**Request Body:**
```json
{
  "message": "What is diabetes and how is it managed in Singapore?",
  "patient_id": "patient-fhir-uuid",
  "image": null,
  "thinking_effort": "balanced"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | Patient's message text |
| `patient_id` | string | Yes | FHIR Patient resource ID |
| `image` | string | No | Base64-encoded image (JPEG/PNG) |
| `thinking_effort` | string | No | `quick`, `balanced`, or `deep` (default: `balanced`) |

**Response:**
```json
{
  "role": "assistant",
  "content": "Diabetes mellitus is a condition where the body cannot properly manage sugar...\n\nSources:\n- MOH Guidelines: https://hpp.moh.gov.sg/guidelines/cpgmed_diabetes_mellitus/\n- Mayo Clinic: https://www.mayoclinic.org/diseases-conditions/diabetes/symptoms-causes/syc-20371444",
  "thinking": null,
  "task_type": "general",
  "language": "en",
  "sources": [
    "https://www.mayoclinic.org/diseases-conditions/diabetes/symptoms-causes/syc-20371444",
    "https://hpp.moh.gov.sg/guidelines/cpgmed_diabetes_mellitus/",
    "https://www.healthhub.sg/programmes/diabetes-hub",
    "https://www.nuh.com.sg/care-at-nuh/services/medicine/endocrinology/understanding-diabetes"
  ],
  "steps": [
    {"action": "Searching WebMD", "category": "search", "tool": "search_webmd", "query": "What is diabetes..."},
    {"action": "Found 5 result(s) from WebMD", "category": "result", "sources_count": 5},
    {"action": "Searching Mayo Clinic", "category": "search", "tool": "search_mayoclinic", "query": "What is diabetes..."},
    {"action": "Found 5 result(s) from Mayo Clinic", "category": "result", "sources_count": 5},
    {"action": "Searching MOH Singapore", "category": "search", "tool": "search_moh_sg", "query": "What is diabetes..."},
    {"action": "Found 5 result(s) from MOH Singapore", "category": "result", "sources_count": 5},
    {"action": "Searching HealthHub SG", "category": "search", "tool": "search_healthhub_sg", "query": "What is diabetes..."},
    {"action": "Found 5 result(s) from HealthHub SG", "category": "result", "sources_count": 5},
    {"action": "Searching NUH Singapore", "category": "search", "tool": "search_nuh", "query": "What is diabetes..."},
    {"action": "Found 5 result(s) from NUH Singapore", "category": "result", "sources_count": 5}
  ],
  "agent": "companion-agent",
  "task_id": "f2307384-97ef-42ce-951b-cee7aaeebae2"
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `content` | string | The agent's answer text. May contain a "Sources:" section at the end. |
| `thinking` | string \| null | Internal chain-of-thought (if model produced `<think>` tags) |
| `sources` | string[] | Array of URLs from RAG search results (WebMD, Mayo Clinic, MOH SG, HealthHub SG, NUH) |
| `steps` | object[] | Timeline of agent actions — use to render a "thinking" UI |
| `agent` | string | Which agent handled the request (e.g. `companion-agent`) |
| `task_id` | string | FHIR Task ID tracking this request |

**Step object shape:**
```typescript
interface Step {
  action: string;      // Human-readable label, e.g. "Searching Mayo Clinic"
  category: string;    // "search" | "result" | "error" | "delegation" | "fhir"
  tool?: string;       // Tool name, e.g. "search_mayoclinic"
  query?: string;      // Search query used
  sources_count?: number; // Number of results found (for "result" category)
}
```

---

### 3. Send Message (Streaming / SSE)

```
POST /sessions/{session_id}/messages/stream
```

Same request body as the sync endpoint. Returns Server-Sent Events (SSE).

**Event stream:**
```
data: {"step": "Understanding your question..."}

data: {"step": "Searching WebMD", "detail": {"action": "Searching WebMD", "category": "search"}}

data: {"step": "Found 5 result(s) from WebMD", "detail": {"action": "Found 5 result(s) from WebMD", "category": "result", "sources_count": 5}}

data: {"step": "Searching Mayo Clinic", "detail": {"action": "Searching Mayo Clinic", "category": "search"}}

... more steps ...

data: {"content": "Diabetes is a chronic...", "thinking": null, "sources": [...], "steps": [...], "agent": "companion-agent", "task_id": "...", "done": true}
```

**How to consume in Flutter/Dart:**
```dart
final request = http.Request('POST', Uri.parse('$baseUrl/sessions/$sessionId/messages/stream'));
request.headers['Content-Type'] = 'application/json';
request.body = jsonEncode({'message': text, 'patient_id': patientId});

final response = await http.Client().send(request);
await for (final chunk in response.stream.transform(utf8.decoder)) {
  for (final line in chunk.split('\n')) {
    if (line.startsWith('data: ')) {
      final data = jsonDecode(line.substring(6));
      if (data['done'] == true) {
        // Final response with content, sources, steps
      } else if (data['step'] != null) {
        // Show in thinking timeline UI
      }
    }
  }
}
```

---

### 4. Get Conversation History

```
GET /sessions/{session_id}/messages
```

**Response:**
```json
{
  "session_id": "abc123...",
  "messages": [
    {"role": "user", "content": "What is diabetes?"},
    {"role": "assistant", "content": "Diabetes mellitus is..."}
  ]
}
```

---

### 5. Delete Session

```
DELETE /sessions/{session_id}
```

Returns `204 No Content`.

---

### 6. Health Check

```
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "vllm": "ok",
  "redis": "ok",
  "medplum": "ok"
}
```

---

### 7. List Agents

```
GET /agents
```

**Response:**
```json
{
  "agents": [
    "companion-agent",
    "clinical-reasoning-agent",
    "nudge-agent",
    "lifestyle-agent",
    "insight-synthesis-agent"
  ],
  "count": 5
}
```

---

### 8. Fire System Trigger

```
POST /triggers/{trigger_type}
```

Manually fire a nudge or measurement trigger for testing.

**Trigger types:** `missed_dose`, `high_biometric`, `daily_checkin`, `appointment_reminder`, `pro_schedule`, `engagement_decay`, `behavioral_anticipation`, `measurement_schedule`

**Request Body:**
```json
{
  "patient_id": "patient-fhir-uuid",
  "context": {}
}
```

---

## Mobile App UI Recommendations

### Thinking Timeline

Use the `steps` array to render a real-time thinking UI:

```
🔍 Searching WebMD...
✅ Found 5 results from WebMD
🔍 Searching Mayo Clinic...
✅ Found 5 results from Mayo Clinic
🔍 Searching MOH Singapore...
✅ Found 5 results from MOH Singapore
🔍 Searching HealthHub SG...
✅ Found 5 results from HealthHub SG
🔍 Searching NUH Singapore...
✅ Found 5 results from NUH Singapore
💬 Generating answer...
```

Map `category` to icons:
- `search` → 🔍
- `result` → ✅
- `error` → ⚠️
- `delegation` → 🤝
- `fhir` → 📋

### Sources Display

Render the `sources` array as tappable chips or a collapsible "References" section below the answer:

```
📚 References (25)
├── Mayo Clinic: Diabetes - Symptoms and causes
├── MOH Singapore: Clinical Practice Guidelines
├── HealthHub SG: Diabetes Hub
├── NUH: Understanding Diabetes
└── ... more
```

### Response Cleaning

The `content` field may contain:
- `<answer>...</answer>` tags — strip them
- A `Sources:` text block at the end — you can hide this if you're using the `sources` array instead
- Chinese text — the model sometimes defaults to Mandarin; this will improve with future model updates

---

## Error Handling

| HTTP Code | Meaning | Action |
|-----------|---------|--------|
| 200 | Success | Parse response normally |
| 404 | Session not found | Create a new session |
| 500 | Server error | Show "Try again" message |

If `content` is `"I'm having trouble right now. Please try again in a moment."`, the agent failed internally — retry after a few seconds.

---

## Architecture

```
Mobile App
    │
    ▼
┌─────────────────────────────────────────┐
│  Med-SEAL Agent API (:8080)             │
│  ┌─────────┐  ┌──────────────────────┐  │
│  │ G1 Guard│→ │ O1 Orchestrator      │  │
│  │ (input) │  │ (rule-based routing) │  │
│  └─────────┘  └──────┬───────────────┘  │
│                       │                  │
│  ┌────────┬───────┬───┴──┬────────┬───┐  │
│  │A1      │A2     │A3    │A4      │A5 │  │
│  │Compan- │Clini- │Nudge │Life-   │In-│  │
│  │ion     │cal    │      │style   │si-│  │
│  │        │Reason │      │        │ght│  │
│  └───┬────┴───────┴──────┴────────┴───┘  │
│      │ RAG Search                        │
│  ┌───┴──────────────────────────────┐    │
│  │ WebMD │ Mayo │ MOH │ HHub │ NUH │    │
│  └──────────────────────────────────┘    │
│      │                                   │
│  ┌───┴────┐                              │
│  │G1 Guard│ (output)                     │
│  └────────┘                              │
└──────────────┬──────────────────────────┘
               │
    ┌──────────┴──────────┐
    ▼                     ▼
┌────────┐         ┌──────────┐
│ vLLM   │         │ Medplum  │
│ Med-R1 │         │ FHIR R4  │
│ (:8000)│         │          │
└────────┘         └──────────┘
```
