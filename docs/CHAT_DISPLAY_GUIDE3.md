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

## Streaming Implementation (SSE) — RECOMMENDED

Use the streaming endpoint to show the thinking timeline in real-time as the agent works, then reveal the answer when done. This creates a ChatGPT/Gemini-like experience.

### SSE Event Flow

The server sends events in this order:

```
data: {"step":"Understanding your question...","detail":{"action":"Understanding your question...","category":"thinking"},"done":false}

data: {"step":"Searching WebMD","detail":{"action":"Searching WebMD","category":"search","tool":"search_webmd"},"done":false}

data: {"step":"Searching Mayo Clinic","detail":{"action":"Searching Mayo Clinic","category":"search","tool":"search_mayoclinic"},"done":false}

data: {"step":"Searching MOH Singapore","detail":{"action":"Searching MOH Singapore","category":"search","tool":"search_moh_sg"},"done":false}

data: {"step":"Found 5 result(s) from WebMD","detail":{"action":"Found 5 result(s) from WebMD","category":"result","sources_count":5},"done":false}

data: {"step":"Health profile loaded","detail":{"action":"Health profile loaded","category":"result"},"done":false}

data: {"step":"Reviewing patient profile","detail":{"action":"Reviewing patient profile","category":"thinking"},"done":false}

data: {"step":"Composing your answer...","detail":{"action":"Composing your answer...","category":"thinking"},"done":false}

data: {"content":"Back pain can...","sources":[...],"steps":[...],"context":{...},"done":true}
```

### How to render the loading animation

**Phase 1: Thinking steps arrive one by one (`done: false`)**

Show each step as an animated list item. The latest step has a spinner/pulse, completed steps have a checkmark.

```
┌─ Assistant (loading) ─────────────────────┐
│                                           │
│  🔍 Understanding your question    ✓      │
│  🔍 Searching WebMD               ✓      │
│  🔍 Searching Mayo Clinic          ✓      │
│  🔍 Searching MOH Singapore       ●←pulse │
│                                           │
└───────────────────────────────────────────┘
```

**Phase 2: More steps arrive**

```
┌─ Assistant (loading) ─────────────────────┐
│                                           │
│  🔍 Searching WebMD               ✓      │
│  🔍 Searching Mayo Clinic          ✓      │
│  🔍 Searching MOH Singapore       ✓      │
│  ✅ Found 5 results from WebMD    ✓      │
│  📋 Health profile loaded          ✓      │
│  🧠 Reviewing patient profile      ✓      │
│  💬 Composing your answer...      ●←pulse │
│                                           │
└───────────────────────────────────────────┘
```

**Phase 3: Final response arrives (`done: true`)**

Collapse the thinking steps into the context pill, show the answer with a fade-in.

```
┌─ Assistant ───────────────────────────────┐
│                                           │
│ 🔍 Searched 3 sources · used patient  [▸] │
│    record                                 │
│                                           │
│ Back pain can have several causes, and    │
│ given your health profile, your weight    │
│ may be putting extra strain on your       │
│ lower back. Since you have kidney         │
│ conditions, it's also worth mentioning    │
│ that kidney issues can sometimes cause    │
│ back discomfort. I'd recommend talking    │
│ to your doctor about this.               │
│                                           │
│ 📚 Mayo Clinic  📚 WebMD  📚 MOH SG      │
│                                           │
└───────────────────────────────────────────┘
```

### Flutter/Dart API Client

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
            yield jsonDecode(line.substring(6));
          } catch (_) {}
        }
      }
    }
  }
}
```

### Flutter Widget Integration

```dart
class ChatMessageWidget extends StatefulWidget {
  final String sessionId;
  final String message;
  final String patientId;
  const ChatMessageWidget({required this.sessionId, required this.message, required this.patientId});

  @override
  State<ChatMessageWidget> createState() => _ChatMessageWidgetState();
}

class _ChatMessageWidgetState extends State<ChatMessageWidget> {
  final List<Map<String, dynamic>> _steps = [];
  String? _content;
  Map<String, dynamic>? _context;
  List<String>? _sources;
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _stream();
  }

  void _stream() async {
    final api = MedSealApi();
    await for (final event in api.streamMessage(
      sessionId: widget.sessionId,
      message: widget.message,
      patientId: widget.patientId,
    )) {
      if (event['done'] == true) {
        setState(() {
          _content = event['content'];
          _context = event['context'];
          _sources = List<String>.from(event['sources'] ?? []);
          _isLoading = false;
        });
      } else if (event['step'] != null) {
        setState(() {
          _steps.add(event['detail'] ?? {'action': event['step'], 'category': 'thinking'});
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Phase 1 & 2: Show thinking steps while loading
        if (_isLoading)
          _ThinkingTimeline(steps: _steps)
        // Phase 3: Show context pill when done
        else if (_context != null)
          _ContextPill(context: _context!),

        // Show answer when done
        if (_content != null)
          Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Text(_content!, style: TextStyle(fontSize: 16)),
          ),

        // Source chips
        if (_sources != null && _sources!.isNotEmpty)
          _SourceChips(sources: _sources!),
      ],
    );
  }
}

class _ThinkingTimeline extends StatelessWidget {
  final List<Map<String, dynamic>> steps;
  const _ThinkingTimeline({required this.steps});

  IconData _iconFor(String category) {
    switch (category) {
      case 'search': return Icons.search;
      case 'result': return Icons.check_circle;
      case 'fhir':   return Icons.medical_information;
      case 'thinking': return Icons.psychology;
      case 'error':  return Icons.warning;
      default: return Icons.circle;
    }
  }

  Color _colorFor(String category) {
    switch (category) {
      case 'search': return Colors.indigo;
      case 'result': return Colors.green;
      case 'fhir':   return Colors.cyan;
      case 'thinking': return Colors.purple;
      case 'error':  return Colors.orange;
      default: return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.grey.shade50,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (int i = 0; i < steps.length; i++)
            AnimatedOpacity(
              opacity: 1.0,
              duration: Duration(milliseconds: 200),
              child: Padding(
                padding: EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    // Spinner for last item, checkmark for others
                    if (i == steps.length - 1)
                      SizedBox(
                        width: 16, height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    else
                      Icon(
                        _iconFor(steps[i]['category'] ?? ''),
                        size: 16,
                        color: _colorFor(steps[i]['category'] ?? ''),
                      ),
                    SizedBox(width: 8),
                    Text(
                      steps[i]['action'] ?? '',
                      style: TextStyle(
                        fontSize: 13,
                        color: Colors.grey.shade700,
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}
```

### If using the sync endpoint instead

If the app uses the non-streaming endpoint (`POST /sessions/{id}/messages`), animate the steps client-side:

```dart
// Get full response
final response = await api.sendMessage(...);
final steps = response['steps'] as List;
final content = response['content'];

// Animate steps one by one (200ms each)
for (final step in steps) {
  setState(() => visibleSteps.add(step));
  await Future.delayed(Duration(milliseconds: 200));
}

// Then show the answer with fade-in
setState(() => showAnswer = true);
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

## Session & Memory Management

The agent server uses **SQLite** for persistent session storage. Conversations are saved to a local database file (`medseal_sessions.db`) and are remembered across app restarts and server restarts — no external database service required.

### How sessions work

```
1. App calls POST /sessions → gets session_id
2. App stores session_id locally (SharedPreferences / UserDefaults / AsyncStorage)
3. All messages use the same session_id → agent remembers the full conversation
4. Agent personalizes responses based on conversation history
5. Session data is persisted to SQLite on disk → survives server restarts
```

### Session lifecycle

| Action | When to do it |
|--------|--------------|
| `POST /sessions` | When user opens a new chat / first launch / taps "New Chat" |
| Store `session_id` locally | Immediately after creation |
| Reuse `session_id` | For every message in the same conversation |
| `GET /sessions/{id}/messages` | To restore chat history on app reopen |
| `DELETE /sessions/{id}` | When user taps "Delete Chat" |

### Multi-turn memory

The agent remembers everything within a session. Example:

```
User: "What are my medications?"
Agent: "You're taking simvastatin, lisinopril, metoprolol..."

User: "What is the simvastatin for?"          ← agent remembers context
Agent: "Simvastatin helps manage your cholesterol levels..."

User: "Any side effects I should watch for?"  ← agent knows we're talking about simvastatin
Agent: "Common side effects include muscle pain..."
```

### App implementation

```dart
class SessionManager {
  static const _key = 'medseal_session_id';

  // Get or create session
  static Future<String> getSession() async {
    final prefs = await SharedPreferences.getInstance();
    String? sessionId = prefs.getString(_key);

    if (sessionId == null) {
      // Create new session
      final resp = await http.post(Uri.parse('$baseUrl/sessions'));
      sessionId = jsonDecode(resp.body)['session_id'];
      await prefs.setString(_key, sessionId!);
    }

    return sessionId;
  }

  // Start new chat
  static Future<String> newChat() async {
    final prefs = await SharedPreferences.getInstance();
    final resp = await http.post(Uri.parse('$baseUrl/sessions'));
    final sessionId = jsonDecode(resp.body)['session_id'];
    await prefs.setString(_key, sessionId);
    return sessionId;
  }

  // Restore chat history on app open
  static Future<List<Map>> loadHistory(String sessionId) async {
    try {
      final resp = await http.get(
        Uri.parse('$baseUrl/sessions/$sessionId/messages'),
      );
      if (resp.statusCode == 200) {
        return List<Map>.from(jsonDecode(resp.body)['messages']);
      }
    } catch (_) {}
    return [];
  }
}
```

### Patient ID binding

The `patient_id` must be passed with every message. This links the conversation to a specific FHIR patient record for personalization.

```dart
// The app should know the logged-in patient's FHIR ID
final patientId = currentUser.fhirPatientId;

// Pass it with every message
api.sendMessage(
  sessionId: sessionId,
  message: userInput,
  patientId: patientId,  // ← this enables FHIR personalization
);
```

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
