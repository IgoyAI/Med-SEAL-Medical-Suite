# Pre-Visit Summary — App Integration Guide

> For the mobile app builder agent: how to call, render, and display the Med-SEAL pre-visit summary.

---

## Overview

The **Pre-Visit Summary** aggregates a patient's entire FHIR health record into **11 structured sections** before an appointment.  It runs purely from FHIR data — no LLM needed — so responses are instant and deterministic.

There are **two ways** to trigger it:

| Method | Endpoint | When to use |
|--------|----------|-------------|
| **Dedicated API** | `POST /patients/{id}/previsit-summary` | Appointment detail screen, pre-visit prep screen |
| **Chat** | Send a message like _"Show my pre-visit summary"_ | Inside the chat conversation |

---

## Method 1: Dedicated API (Recommended for UI)

### Request

```
POST /patients/{patient_id}/previsit-summary
```

No request body needed — the patient ID is in the URL path.

**Example:**
```bash
curl -s https://medseal-agent.ngrok-free.dev/patients/4af16daf-1ad0-4a0c-bfff-f070bc61b4c3/previsit-summary \
  -X POST | python -m json.tool
```

### Response

```json
{
  "status": "ok",
  "patient_id": "4af16daf-1ad0-4a0c-bfff-f070bc61b4c3",
  "summary": {
    "patient_id": "4af16daf-1ad0-4a0c-bfff-f070bc61b4c3",
    "active_conditions": [
      "Type 2 Diabetes Mellitus",
      "Essential Hypertension",
      "Hyperlipidemia"
    ],
    "latest_biometrics": [
      {
        "name": "Blood Pressure",
        "components": [
          {"name": "Systolic", "value": 132, "unit": "mmHg"},
          {"name": "Diastolic", "value": 82, "unit": "mmHg"}
        ],
        "when": "2026-03-10T08:30:00+08:00"
      },
      {"name": "Heart Rate", "value": 72, "unit": "bpm", "when": "2026-03-10T08:30:00+08:00"},
      {"name": "Glucose", "value": 6.1, "unit": "mmol/L", "when": "2026-03-09T07:00:00+08:00"}
    ],
    "lab_results": [
      {"name": "HbA1c", "value": 6.8, "unit": "%", "interpretation": "H", "high": true, "when": "2026-03-05"},
      {"name": "LDL Cholesterol", "value": 3.2, "unit": "mmol/L", "interpretation": "H", "high": true, "when": "2026-03-05"}
    ],
    "current_medications": [
      {"name": "Metformin 500mg", "dosage": "Twice daily with meals"},
      {"name": "Amlodipine 5mg", "dosage": "Once daily"},
      {"name": "Atorvastatin 20mg", "dosage": "Once daily at bedtime"},
      {"name": "Lisinopril 10mg", "dosage": "Once daily"}
    ],
    "medication_adherence": {
      "period_days": 30,
      "taken": 26,
      "skipped": 4,
      "adherence_percent": 86.7
    },
    "allergies": ["Penicillin", "Shellfish"],
    "upcoming_appointments": [
      {
        "id": "appt-uuid",
        "start": "2026-03-20T09:00:00+08:00",
        "end": "2026-03-20T09:30:00+08:00",
        "doctor": "Dr Mei Ling Wong",
        "service": "Endocrinology",
        "description": "Diabetes follow-up",
        "status": "booked"
      }
    ],
    "recent_encounters": [
      {"id": "enc-uuid", "status": "finished", "type": "Routine diabetes follow-up", "start": "2026-03-08"}
    ],
    "health_goals": [
      {"id": "goal-uuid", "description": "HbA1c < 6.5%", "lifecycle_status": "active", "achievement_status": "in-progress"},
      {"id": "goal-uuid2", "description": "Weight loss target: 75 kg", "lifecycle_status": "active", "achievement_status": "in-progress"}
    ],
    "active_alerts": [
      {"id": "flag-uuid", "status": "active", "code": "Elevated blood glucose trend"}
    ],
    "clinical_summary": "Patient has 3 active condition(s). Currently on 4 medication(s). Known allergies: Penicillin, Shellfish. Medication adherence is acceptable (86.7%). Elevated lab values: HbA1c, LDL Cholesterol.",
    "generated_at": "2026-03-17T12:00:00+00:00"
  },
  "formatted": "Here is your pre-visit summary from your medical record:\n\n1) Active Conditions\n- Type 2 Diabetes Mellitus, Essential Hypertension, Hyperlipidemia\n\n2) Latest Biometrics\n...",
  "steps": [
    {"action": "Collecting patient records from FHIR", "category": "fhir"},
    {"action": "Pre-visit summary generated", "category": "result"}
  ]
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ok"` or `"error"` | Whether the summary was generated successfully |
| `patient_id` | string | The FHIR Patient ID |
| `summary` | object | **Structured JSON** with all 11 sections (see schema below) |
| `formatted` | string | **Pre-formatted markdown text** ready to display as-is |
| `steps` | array | Timeline steps for UI (same format as chat steps) |

---

## Summary Object Schema

```typescript
interface PrevisitSummary {
  patient_id: string;
  active_conditions: string[];          // Section 1
  latest_biometrics: Biometric[];       // Section 2
  lab_results: LabResult[];             // Section 3
  current_medications: Medication[];    // Section 4
  medication_adherence: Adherence;      // Section 5
  allergies: string[];                  // Section 6
  upcoming_appointments: Appointment[]; // Section 7
  recent_encounters: Encounter[];       // Section 8
  health_goals: Goal[];                 // Section 9
  active_alerts: Alert[];              // Section 10
  clinical_summary: string;             // Section 11
  generated_at: string;                 // ISO timestamp
}

interface Biometric {
  name: string;       // e.g. "Blood Pressure", "Heart Rate"
  value?: number;     // single value (e.g. 72 bpm)
  unit?: string;      // e.g. "bpm", "mmol/L"
  components?: {      // for composite values (e.g. BP has systolic + diastolic)
    name: string;
    value: number;
    unit: string;
  }[];
  when: string;       // ISO datetime
}

interface LabResult {
  name: string;           // e.g. "HbA1c"
  value: number | null;
  unit: string;
  interpretation: string; // "H" = high, "L" = low, "N" = normal
  high: boolean;          // true if flagged as elevated
  when: string;
}

interface Medication {
  name: string;    // e.g. "Metformin 500mg"
  dosage: string;  // e.g. "Twice daily with meals"
}

interface Adherence {
  period_days: number;       // 30
  taken: number;             // doses taken
  skipped: number;           // doses skipped
  adherence_percent: number; // 0-100
}

interface Appointment {
  id: string;
  start: string;       // ISO datetime
  end: string;
  doctor: string;      // e.g. "Dr Mei Ling Wong"
  service: string;     // e.g. "Endocrinology"
  description: string;
  status: string;      // "booked"
}

interface Encounter {
  id: string;
  status: string;   // "finished", "in-progress"
  type: string;     // e.g. "Routine diabetes follow-up"
  start: string;
}

interface Goal {
  id: string;
  description: string;       // e.g. "HbA1c < 6.5%"
  lifecycle_status: string;  // "active", "completed"
  achievement_status: string; // "in-progress", "achieved"
}

interface Alert {
  id: string;
  status: string;  // "active"
  code: string;    // e.g. "Elevated blood glucose trend"
}
```

---

## Method 2: Via Chat

Send any of these messages through the normal chat endpoint:

```
"Show my pre-visit summary"
"Generate my pre-visit summary before my appointment"
"What should I prepare for my visit?"
"Pre-visit summary please"
```

The orchestrator auto-routes these to the `previsit-summary-agent`.

**Response:** Same `AssistantResponse` format as all chat messages, with `content` containing the formatted 11-section summary and `agent` set to `"previsit-summary-agent"`.

---

## UI Rendering Guide

### Option A: Use `summary` (structured JSON) — Recommended

Build a custom card-based UI from the structured data. This gives full control over styling.

```
┌─────────────────────────────────────────────────┐
│ 📋 Pre-Visit Summary                           │
│ Generated: 17 Mar 2026, 12:00 PM               │
├─────────────────────────────────────────────────┤
│                                                 │
│ ❤️ Active Conditions                            │
│ ┌─────────────────────────────────────────────┐ │
│ │ • Type 2 Diabetes Mellitus                  │ │
│ │ • Essential Hypertension                    │ │
│ │ • Hyperlipidemia                            │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ 🩺 Latest Biometrics                            │
│ ┌─────────────────────────────────────────────┐ │
│ │ BP:      132/82 mmHg                        │ │
│ │ HR:      72 bpm                             │ │
│ │ Glucose: 6.1 mmol/L                         │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ 🔬 Lab Results                                  │
│ ┌─────────────────────────────────────────────┐ │
│ │ HbA1c:         6.8%        ⚠️ HIGH          │ │
│ │ LDL Chol:      3.2 mmol/L  ⚠️ HIGH          │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ 💊 Current Medications                          │
│ ┌─────────────────────────────────────────────┐ │
│ │ • Metformin 500mg — twice daily with meals  │ │
│ │ • Amlodipine 5mg — once daily               │ │
│ │ • Atorvastatin 20mg — once daily at bedtime │ │
│ │ • Lisinopril 10mg — once daily              │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ 📊 Medication Adherence (30 days)               │
│ ┌─────────────────────────────────────────────┐ │
│ │ ████████████████████░░░ 86.7%               │ │
│ │ 26 taken · 4 skipped                        │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ ⚠️ Allergies                                    │
│ ┌─────────────────────────────────────────────┐ │
│ │ 🔴 Penicillin   🔴 Shellfish                │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ 📅 Upcoming Appointments                        │
│ ┌─────────────────────────────────────────────┐ │
│ │ 20 Mar 09:00 AM                             │ │
│ │ Dr Mei Ling Wong (Endocrinology)            │ │
│ │ Diabetes follow-up                          │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ 🏥 Recent Encounters                            │
│ ┌─────────────────────────────────────────────┐ │
│ │ 8 Mar — Routine diabetes follow-up ✅        │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ 🎯 Health Goals                                 │
│ ┌─────────────────────────────────────────────┐ │
│ │ 🔄 HbA1c < 6.5%                             │ │
│ │ 🔄 Weight loss target: 75 kg                │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ 🚨 Active Alerts                                │
│ ┌─────────────────────────────────────────────┐ │
│ │ 🔴 Elevated blood glucose trend             │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ 📝 Clinical Summary                             │
│ ┌─────────────────────────────────────────────┐ │
│ │ Patient has 3 active condition(s). Currently│ │
│ │ on 4 medication(s). Known allergies:        │ │
│ │ Penicillin, Shellfish. Medication adherence │ │
│ │ is acceptable (86.7%). Elevated lab values: │ │
│ │ HbA1c, LDL Cholesterol.                    │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Option B: Use `formatted` (plain text) — Quick

Display the `formatted` string directly as markdown text in a chat bubble or card. Good for a quick implementation.

---

## Flutter/Dart Implementation

### Fetching the summary

```dart
Future<PrevisitSummary> fetchPrevisitSummary(String patientId) async {
  final response = await http.post(
    Uri.parse('$baseUrl/patients/$patientId/previsit-summary'),
    headers: {'Content-Type': 'application/json'},
  );
  
  if (response.statusCode == 200) {
    final data = jsonDecode(response.body);
    return PrevisitSummary.fromJson(data['summary']);
  }
  throw Exception('Failed to load pre-visit summary');
}
```

### Rendering adherence bar

```dart
Widget buildAdherenceBar(double percent) {
  Color barColor;
  String label;
  if (percent >= 95) {
    barColor = Colors.green;
    label = 'Excellent';
  } else if (percent >= 80) {
    barColor = Colors.orange;
    label = 'Acceptable';
  } else {
    barColor = Colors.red;
    label = 'Needs Improvement';
  }
  
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text('$label (${percent.toStringAsFixed(1)}%)',
        style: TextStyle(fontWeight: FontWeight.bold, color: barColor)),
      SizedBox(height: 4),
      LinearProgressIndicator(
        value: percent / 100,
        backgroundColor: Colors.grey[200],
        valueColor: AlwaysStoppedAnimation(barColor),
      ),
    ],
  );
}
```

### Rendering lab results with HIGH flag

```dart
Widget buildLabResult(Map<String, dynamic> lab) {
  final isHigh = lab['high'] == true;
  return Row(
    children: [
      Expanded(child: Text(lab['name'])),
      Text('${lab['value']} ${lab['unit']}',
        style: TextStyle(
          fontWeight: FontWeight.bold,
          color: isHigh ? Colors.red : Colors.black87,
        )),
      if (isHigh) ...[
        SizedBox(width: 4),
        Icon(Icons.warning_amber, color: Colors.red, size: 16),
        Text(' HIGH', style: TextStyle(color: Colors.red, fontSize: 12)),
      ],
    ],
  );
}
```

### Rendering allergy chips

```dart
Widget buildAllergyChips(List<String> allergies) {
  return Wrap(
    spacing: 8,
    children: allergies.map((a) => Chip(
      avatar: Icon(Icons.warning, color: Colors.red, size: 16),
      label: Text(a),
      backgroundColor: Colors.red[50],
    )).toList(),
  );
}
```

---

## When to Show the Pre-Visit Summary

| Trigger | Action |
|---------|--------|
| User opens appointment detail page | Auto-fetch `POST /patients/{pid}/previsit-summary` |
| User taps "Prepare for visit" button | Fetch and display the summary card |
| 24 hours before an appointment | Push notification → "Your pre-visit summary is ready" → open summary |
| User asks in chat: "What should I prepare?" | Agent returns the formatted summary inline |

---

## Section Icon Mapping

Use these icons when rendering each section:

| # | Section | Icon |
|---|---------|------|
| 1 | Active Conditions | ❤️ or 🩺 |
| 2 | Latest Biometrics | 📊 |
| 3 | Lab Results | 🔬 |
| 4 | Current Medications | 💊 |
| 5 | Medication Adherence | 📈 |
| 6 | Allergies | ⚠️ |
| 7 | Upcoming Appointments | 📅 |
| 8 | Recent Encounters | 🏥 |
| 9 | Health Goals | 🎯 |
| 10 | Active Alerts | 🚨 |
| 11 | Clinical Summary | 📝 |

---

## Adherence Color Coding

| Adherence % | Color | Label | Emoji |
|-------------|-------|-------|-------|
| ≥ 95% | Green | Excellent | ✅ |
| 80–94% | Orange | Acceptable | 🟡 |
| < 80% | Red | Needs Improvement | ⚠️ |

---

## Error Handling

| Scenario | `status` | What to show |
|----------|----------|--------------|
| Success | `"ok"` | Full summary card |
| Patient not found | `"error"` | "Patient record not found. Please check your patient ID." |
| FHIR server down | `"error"` | "Unable to load your health records right now. Please try again." |
| No data | `"ok"` (with empty arrays) | Show "No data recorded" in each empty section |

---

## Refresh & Caching

- The summary is **generated fresh on every call** (no server-side cache).
- The app should cache the response locally for **15 minutes** to avoid redundant calls.
- Show a "Last updated: X minutes ago" timestamp from `generated_at`.
- Add a **pull-to-refresh** or refresh button to re-fetch.

---

## Architecture

```
Mobile App
    │
    ├── Appointment Detail Screen
    │   └── POST /patients/{pid}/previsit-summary
    │       └── Returns structured JSON + formatted text
    │
    └── Chat Screen
        └── "Show my pre-visit summary"
            └── Routed to previsit-summary-agent
                └── Returns formatted text in chat bubble
```

Both paths call the same FHIR queries under the hood.
