# Med-SEAL Chat Display — Implementation Guide for App Builder

## Overview

This guide explains how to render the Med-SEAL agent responses in a chat UI. The agent API returns structured data that should be displayed as a rich chat experience with context indicators, thinking timelines, source citations, and clean conversational messages — similar to ChatGPT, Gemini, or Claude.

## API Endpoint

```
Base URL: https://medseal-agent.ngrok-free.dev
```

| Action | Method | Endpoint |
|--------|--------|----------|
| Create session | POST | `/sessions` |
| Send message | POST | `/sessions/{id}/messages` |
| Send message (streaming) | POST | `/sessions/{id}/messages/stream` |
| Get history | GET | `/sessions/{id}/messages` |
| Delete session | DELETE | `/sessions/{id}` |

## Request Format

```json
POST /sessions/{session_id}/messages
Content-Type: application/json

{
  "message": "Why is my back hurting?",
  "patient_id": "89d893d0-550e-41ed-8670-2774cb5e8f4d"
}
```

## Response Format

```json
{
  "role": "assistant",
  "content": "Back pain can have several causes...",
  "thinking": null,
  "sources": [
    "https://www.mayoclinic.org/diseases-conditions/back-pain/...",
    "https://www.webmd.com/back-pain/..."
  ],
  "steps": [
    {"action": "Searching WebMD", "category": "search", "tool": "search_webmd"},
    {"action": "Found 5 result(s) from WebMD", "category": "result", "sources_count": 5},
    {"action": "Searching Mayo Clinic", "category": "search", "tool": "search_mayoclinic"},
    {"action": "Found 5 result(s) from Mayo Clinic", "category": "result", "sources_count": 5},
    {"action": "Loading your health profile", "category": "fhir"},
    {"action": "Health profile loaded", "category": "result"},
    {"action": "Reviewing patient profile", "category": "thinking"},
    {"action": "Checking medications", "category": "thinking"},
    {"action": "Composing personalized response", "category": "thinking"}
  ],
  "context": {
    "label": "Searched 3 sources · used patient record",
    "sources_used": 10,
    "patient_record_loaded": true,
    "search_engines": ["WebMD", "Mayo Clinic", "MOH Singapore"],
    "details": [
      "Reading patient health record",
      "Patient profile loaded",
      "Reviewing patient profile",
      "Checking medications",
      "Composing personalized response"
    ]
  },
  "agent": "companion-agent",
  "task_id": "abc-123"
}
```

---

## Chat Bubble Layout

Each assistant message should be rendered as:

```
┌──────────────────────────────────────────────────┐
│                                                  │
│  ┌─── Context Pill (collapsible) ─────────────┐  │
│  │ 🔍 Searched 3 sources · used patient record│  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌─── Thinking Timeline (expanded from pill) ─┐  │
│  │ 🔍 Searching WebMD                         │  │
│  │ ✅ Found 5 results                         │  │
│  │ 🔍 Searching Mayo Clinic                   │  │
│  │ ✅ Found 5 results                         │  │
│  │ 📋 Loading your health profile             │  │
│  │ ✅ Health profile loaded                   │  │
│  │ 🧠 Reviewing patient profile               │  │
│  │ 💊 Checking medications                    │  │
│  │ 💬 Composing personalized response         │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌─── Message Content ────────────────────────┐  │
│  │ Back pain can have several causes,         │  │
│  │ especially given your current health       │  │
│  │ profile. Your obesity and conditions like  │  │
│  │ hypertension may contribute to extra       │  │
│  │ strain on your lower back...               │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌─── Sources (collapsible chips) ────────────┐  │
│  │ 📚 Mayo Clinic  📚 WebMD  📚 MOH SG       │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
└──────────────────────────────────────────────────┘
```

---

## Component 1: Context Pill

The `context` object renders as a single-line collapsible pill at the top of the assistant message. This is like Claude's context indicator circle.

### Data mapping

| Field | How to render |
|-------|---------------|
| `context.label` | Main text of the pill (e.g. "Searched 3 sources · used patient record") |
| `context.sources_used` | Badge count (e.g. "15 refs") |
| `context.patient_record_loaded` | Show a 📋 icon if true |
| `context.search_engines` | List of engine names for tooltip |
| `context.details` | Expanded timeline when pill is tapped |

### States

1. **Collapsed (default):** Single line showing `context.label`
   ```
   🔍 Searched 3 sources · used patient record  ▸
   ```

2. **Expanded (on tap):** Shows `context.details` as a timeline
   ```
   🔍 Searched 3 sources · used patient record  ▾
   ├── 📋 Reading patient health record
   ├── ✅ Patient profile loaded
   ├── 🧠 Reviewing patient profile
   ├── 💊 Checking medications
   └── 💬 Composing personalized response
   ```

### Design specs

- Background: subtle gray/blue tint (`#F0F4F8` light / `#1E293B` dark)
- Border radius: 12px
- Font: 13px, medium weight
- Icon: 🔍 or a custom search icon
- Tap to expand/collapse with smooth animation (200ms ease)
- If `context` is null or `label` is empty, don't render the pill

---

## Component 2: Thinking Timeline (SSE Streaming)

For the streaming endpoint (`/sessions/{id}/messages/stream`), show steps in real-time as they arrive via SSE.

### SSE Event format

```
data: {"step": "Searching WebMD", "detail": {"action": "Searching WebMD", "category": "search"}}
data: {"step": "Found 5 results from WebMD", "detail": {"action": "Found 5 results", "category": "result"}}
...
data: {"content": "...", "context": {...}, "done": true}
```

### Rendering logic

While streaming, show an animated timeline that builds up step by step:

```
🔍 Searching WebMD...          ← appears first (with spinner)
✅ Found 5 results              ← replaces spinner with checkmark
🔍 Searching Mayo Clinic...     ← next step
✅ Found 5 results
📋 Loading health profile...
✅ Health profile loaded
🧠 Analyzing your data...       ← thinking steps
💬 Writing response...
```

When `done: true` arrives, collapse the timeline into the context pill and show the message content.

### Icon mapping by category

```
category: "search"    → 🔍 (or magnifying glass icon)
category: "result"    → ✅ (or checkmark icon)
category: "fhir"      → 📋 (or medical record icon)
category: "thinking"  → 🧠 (or brain icon)
category: "error"     → ⚠️ (or warning icon)
```

### Animation

1. Each step fades in (150ms) with a slight slide-up (8px)
2. "search" steps show a pulsing dot/spinner until their matching "result" step arrives
3. When `done: true`, the timeline collapses into the context pill (300ms transition)
4. Message content types in with a subtle fade-in below the pill

---

## Component 3: Message Content

The `content` field contains the clean, patient-facing response. It may contain:

- Plain text paragraphs
- Markdown-style bold (`**text**`) — render as bold
- Inline source references like `Sources:\n- Name: URL` at the end

### Rendering rules

1. **Strip `<answer>` and `<think>` tags** if present
2. **Parse "Sources:" section** at the end — if found, extract and move to the Sources component instead of displaying inline
3. **Render as rich text** with paragraph spacing
4. **Do NOT render** raw medical data, FHIR IDs, or clinical codes — the API already strips these, but guard against any leaks
5. **Linkify** any URLs that appear in the text

### Text cleaning regex

```dart
// Strip answer tags
content = content.replaceAll(RegExp(r'</?answer\s*>', caseSensitive: false), '');

// Strip think tags
content = content.replaceAll(RegExp(r'<think>.*?</think>', dotAll: true), '');

// Extract and remove Sources section
final sourcesMatch = RegExp(r'\nSources?:\s*\n([\s\S]*)$').firstMatch(content);
if (sourcesMatch != null) {
  inlineSources = sourcesMatch.group(1);
  content = content.substring(0, sourcesMatch.start).trim();
}

// Strip any leaked UUIDs
content = content.replaceAll(RegExp(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'), '');
```

---

## Component 4: Source Citations

The `sources` array contains URLs from medical databases. Render as tappable chips or a collapsible section below the message.

### Design option A: Chips row (recommended)

```
📚 Mayo Clinic  📚 WebMD  📚 MOH SG  +7 more
```

- Show first 3 sources as chips
- "+N more" chip expands to full list
- Each chip opens the URL in an in-app browser
- Extract the domain name for the chip label:
  ```dart
  String getSourceLabel(String url) {
    if (url.contains('mayoclinic.org')) return 'Mayo Clinic';
    if (url.contains('webmd.com')) return 'WebMD';
    if (url.contains('moh.gov.sg') || url.contains('hpp.moh.gov.sg')) return 'MOH Singapore';
    if (url.contains('healthhub.sg')) return 'HealthHub SG';
    if (url.contains('nuh.com.sg')) return 'NUH Singapore';
    return Uri.parse(url).host.replaceAll('www.', '');
  }
  ```

### Design option B: Collapsible list

```
📚 References (15)                    [▸]
```
Expanded:
```
📚 References (15)                    [▾]
├── Mayo Clinic: Diabetes - Symptoms and causes
├── Mayo Clinic: Type 2 diabetes treatment
├── WebMD: High Blood Pressure
├── MOH Singapore: Clinical Practice Guidelines
├── HealthHub SG: Diabetes Hub
└── ... 10 more
```

### Source deduplication

The `sources` array may contain duplicate domains. Group by domain:

```dart
Map<String, List<String>> groupedSources = {};
for (var url in sources) {
  var label = getSourceLabel(url);
  groupedSources.putIfAbsent(label, () => []).add(url);
}
// Render: "Mayo Clinic (3)" "WebMD (5)" etc.
```

---

## Component 5: User Message Bubble

Simple text bubble with the patient's message.

```
┌──────────────────────────────┐
│ Why is my back hurting?      │
└──────────────────────────────┘
                          ← right-aligned
```

---

## Full Chat Flow Example

```
┌─ User ──────────────────────────────────────────┐
│                  Why is my back hurting?         │
└─────────────────────────────────────────────────┘

┌─ Assistant ─────────────────────────────────────┐
│                                                 │
│ 🔍 Searched 3 sources · used patient record [▾] │
│ ├── 📋 Patient profile loaded                   │
│ ├── 🧠 Reviewing conditions                     │
│ ├── 💊 Checking medications                     │
│ └── 💬 Composing response                       │
│                                                 │
│ Back pain can have several causes, and given    │
│ your health profile, there are a few things     │
│ worth considering. Your weight and BMI may be   │
│ putting extra strain on your lower back, which  │
│ is very common. Additionally, since you have    │
│ kidney-related conditions, it's worth           │
│ mentioning that kidney issues can sometimes     │
│ cause back discomfort. I'd recommend discussing │
│ this with your doctor at your next visit,       │
│ especially if the pain persists or worsens.     │
│                                                 │
│ 📚 Mayo Clinic  📚 WebMD  📚 MOH SG  +5 more   │
│                                                 │
└─────────────────────────────────────────────────┘

┌─ User ──────────────────────────────────────────┐
│                  What medications am I on?       │
└─────────────────────────────────────────────────┘

┌─ Assistant ─────────────────────────────────────┐
│                                                 │
│ 📋 Used patient record                     [▸]  │
│                                                 │
│ You're currently taking a few medications to    │
│ help manage your health. These include          │
│ simvastatin for cholesterol, lisinopril and     │
│ metoprolol for blood pressure, and              │
│ nitroglycerin spray for your heart. If you'd    │
│ like to know more about any of these, just ask! │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## Streaming Implementation (Dart/Flutter)

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

class MedSealApi {
  final String baseUrl = 'https://medseal-agent.ngrok-free.dev';

  Future<String> createSession() async {
    final resp = await http.post(Uri.parse('$baseUrl/sessions'));
    return jsonDecode(resp.body)['session_id'];
  }

  Stream<Map<String, dynamic>> streamMessage({
    required String sessionId,
    required String message,
    required String patientId,
  }) async* {
    final request = http.Request(
      'POST',
      Uri.parse('$baseUrl/sessions/$sessionId/messages/stream'),
    );
    request.headers['Content-Type'] = 'application/json';
    request.body = jsonEncode({
      'message': message,
      'patient_id': patientId,
    });

    final response = await http.Client().send(request);

    await for (final chunk in response.stream.transform(utf8.decoder)) {
      for (final line in chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            final data = jsonDecode(line.substring(6));
            yield data;
          } catch (_) {}
        }
      }
    }
  }

  Future<Map<String, dynamic>> sendMessage({
    required String sessionId,
    required String message,
    required String patientId,
  }) async {
    final resp = await http.post(
      Uri.parse('$baseUrl/sessions/$sessionId/messages'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'message': message,
        'patient_id': patientId,
      }),
    );
    return jsonDecode(resp.body);
  }
}
```

### Usage in a Flutter widget

```dart
// Streaming with thinking timeline
final stream = api.streamMessage(
  sessionId: sessionId,
  message: userMessage,
  patientId: currentPatientId,
);

List<Map<String, dynamic>> thinkingSteps = [];
String? finalContent;
Map<String, dynamic>? context;
List<String>? sources;

await for (final event in stream) {
  if (event['done'] == true) {
    // Final response
    finalContent = event['content'];
    context = event['context'];
    sources = List<String>.from(event['sources'] ?? []);
    setState(() {}); // Collapse timeline, show message
  } else if (event['step'] != null) {
    // Add to thinking timeline
    thinkingSteps.add(event['detail'] ?? {'action': event['step']});
    setState(() {}); // Animate new step
  }
}
```

---

## Color Palette Suggestion

| Element | Light Mode | Dark Mode |
|---------|-----------|-----------|
| Context pill bg | `#EFF6FF` | `#1E3A5F` |
| Context pill text | `#1E40AF` | `#93C5FD` |
| Thinking step text | `#6B7280` | `#9CA3AF` |
| Source chip bg | `#F0FDF4` | `#14532D` |
| Source chip text | `#166534` | `#86EFAC` |
| User bubble bg | `#3B82F6` | `#2563EB` |
| Assistant bubble bg | `#FFFFFF` | `#1F2937` |
| Search icon | `#6366F1` | `#818CF8` |
| FHIR icon | `#0891B2` | `#22D3EE` |
| Thinking icon | `#8B5CF6` | `#A78BFA` |

---

## Error States

| Scenario | What to show |
|----------|-------------|
| `content` is error message | Show in red-tinted bubble with retry button |
| `context` is null | Don't show context pill |
| `sources` is empty | Don't show source chips |
| `steps` is empty | Don't show thinking timeline |
| Network error | Show "Connection lost. Tap to retry." |
| Session expired (404) | Auto-create new session, inform user |
