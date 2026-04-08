# Med-SEAL Agent API — Mobile App Integration Guide

## Connection Details

| Setting | Value |
|---------|-------|
| **Base URL** | `https://medseal-llm.ngrok-free.dev` (vLLM direct) |
| **Agent API** | `http://<hopper-24-ip>:8080` (Med-SEAL orchestrator) |
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
| `content` | string | The agent's answer text (clean, patient-friendly — no raw data or CoT) |
| `thinking` | string \| null | Internal chain-of-thought (hidden from patient, for debugging) |
| `sources` | string[] | Array of URLs from RAG search results |
| `steps` | object[] | Timeline of agent actions — for "thinking" animation |
| `context` | object | Context indicator — render as a collapsible pill in the chat |
| `agent` | string | Which agent handled the request |
| `task_id` | string | FHIR Task ID tracking this request |

**Context indicator object:**
```json
{
  "label": "Searched 3 sources · used patient record",
  "sources_used": 15,
  "patient_record_loaded": true,
  "search_engines": ["WebMD", "Mayo Clinic", "MOH Singapore"],
  "details": [
    "Reading patient health record",
    "Patient profile loaded",
    "Reviewing patient profile",
    "Checking medications",
    "Analyzing lab results",
    "Composing personalized response"
  ]
}
```

**How to render the context indicator (like Claude's circle):**
```
┌──────────────────────────────────────────┐
│ 🔍 Searched 3 sources · used patient     │
│    record                            [v] │
│                                          │
│  (expanded):                             │
│  ├── 📚 WebMD, Mayo Clinic, MOH SG       │
│  ├── 📋 Patient profile loaded           │
│  ├── 🧠 Reviewing patient profile        │
│  ├── 💊 Checking medications             │
│  ├── 🔬 Analyzing lab results            │
│  └── 💬 Composing personalized response  │
└──────────────────────────────────────────┘
```

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
  "sessions": "sqlite",
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
- `appointment` → 📅

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

### Appointment Booking (via Chat)

The Companion Agent supports appointment management directly through chat. No special endpoints needed — just send natural language messages:

| Action | Example messages |
|--------|-----------------|
| Search slots | "I want to book an appointment", "When can I see my doctor?" |
| Book a slot | "Book option 1", "I'll take the Tuesday slot" |
| List appointments | "What are my upcoming appointments?", "When is my next visit?" |
| Cancel | "Cancel my appointment" |

**Appointment flow:**
```
User: "I want to book an appointment"
→ Agent searches FHIR Slot resources, returns options

User: "Book option 2"
→ Agent creates FHIR Appointment, updates Slot to busy, confirms

User: "Show my appointments"
→ Agent lists FHIR Appointments for the patient

User: "Cancel my appointment"
→ Agent cancels the next booked Appointment, frees the Slot
```

The `steps` array will include appointment-specific entries:
```json
{"action": "Searching available appointment slots", "category": "fhir"}
{"action": "Found 3 available slot(s)", "category": "result"}
{"action": "Booking your appointment", "category": "fhir"}
{"action": "Appointment confirmed!", "category": "result"}
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
