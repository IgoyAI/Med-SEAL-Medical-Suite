# Appointment Features Update — App Builder Guide

This guide describes the latest appointment behavior and what the app should change.

---

## What Changed

The appointment flow now has stricter backend verification and better doctor mapping.

### Backend improvements
- Slot search resolves `Schedule -> Practitioner` so each option includes doctor + specialty.
- Booking only returns success after **double verification**:
  - Appointment created and readable from FHIR.
  - Slot status updated to `busy` (when slot-linked).
  - Appointment is visible in patient appointment queries.
- Cancellation only returns success after **double verification**:
  - Appointment status becomes `cancelled`.
  - Slot status becomes `free` (when slot-linked).
- Patient reference normalization is stricter (`Patient/<id>` consistency).

### UX implications
- Never assume booking is successful from button tap alone.
- Trust only agent replies that contain successful booking/cancellation confirmation text.
- Show explicit failure/retry state if backend returns verification failure.

---

## Endpoints To Use

Use existing chat endpoints (no separate appointment endpoint required):

- `POST /sessions`
- `POST /sessions/{session_id}/messages`
- `POST /sessions/{session_id}/messages/stream` (recommended for timeline UX)

---

## Required Request Rules

### 1) Always pass stable `patient_id`
- Use the same FHIR patient ID for all appointment operations.
- If patient context switches, create a new session.

### 2) Keep the same `session_id` for one appointment journey
One journey = slot search -> user picks option -> booking confirmation.

Do not start a new session between:
- "Show available slots"
- "Book option 1"

---

## Recommended Chat Flow

### Step A — Search slots
Send:
```json
{
  "message": "I want to book an appointment",
  "patient_id": "<FHIR_PATIENT_ID>"
}
```

Expected response content includes multiple lines like:
- `Option 1 ... with Dr <name> (<specialty>)`

### Step B — Confirm slot
Send:
```json
{
  "message": "Book option 1",
  "patient_id": "<FHIR_PATIENT_ID>"
}
```

Treat booking as success only if content clearly contains:
- `Your appointment has been booked`
- plus date/time + doctor.

If content contains:
- `[BOOKING FAILED]` semantics / "could not verify", show error and retry CTA.

### Step C — Post-booking verification in UI
Immediately send:
```json
{
  "message": "Show my upcoming appointments",
  "patient_id": "<FHIR_PATIENT_ID>"
}
```

Only mark UI appointment card as final/confirmed if returned list includes the new appointment.

---

## Parsing Guidance For App

Because this is chat-based, use tolerant parsing:

### Booking success indicators
- `booked for`
- `with **Dr`
- `Status: booked`

### Booking failure indicators
- `BOOKING FAILED`
- `could not verify appointment creation`
- `trouble with the appointment system`

### Cancellation success indicators
- `appointment has been cancelled`
- `Appointment ID:`

### Cancellation failure indicators
- `APPOINTMENT CANCEL FAILED`
- `could not be verified`

---

## UI States To Add

Implement explicit states:

- `searching_slots`
- `slots_ready`
- `booking_in_progress`
- `booking_verified`
- `booking_failed_verification`
- `list_refresh_in_progress`
- `cancel_in_progress`
- `cancel_verified`
- `cancel_failed_verification`

Avoid a single generic "Success" toast.

---

## Streaming UX (Recommended)

Use SSE endpoint and show timeline from `steps`:

Key appointment-related step examples:
- `Searching available appointment slots`
- `Found X available slot(s)`
- `Booking your appointment`
- `Appointment confirmed!`
- `Checking your upcoming appointments`
- `Appointment cancelled`

If step category is `error`, keep user on same screen and show retry.

---

## Structured Appointment Metadata (NEW)

The SSE `done` event and non-stream response now include **top-level fields** for appointment state:

| Field | Type | Values |
|---|---|---|
| `appointment_action` | `string \| null` | `"booked"`, `"cancelled"`, `"list"`, `"search"`, `"info"`, or `null` (non-appointment) |
| `appointment_verified` | `bool \| null` | `true` = action succeeded and verified, `false` = action failed, `null` = not an appointment response |

**Use these fields instead of parsing text for verification state:**
- `appointment_action == "list" && appointment_verified == true` → appointments fetched OK, show list
- `appointment_action == "booked" && appointment_verified == true` → booking confirmed
- `appointment_action == "booked" && appointment_verified == false` → booking failed, show retry
- `appointment_action == "cancelled" && appointment_verified == true` → cancellation confirmed
- `appointment_action == "search" && appointment_verified == true` → slots found, show options
- `appointment_action == null` → not an appointment response, no verification UI needed

**Do NOT show "Booking Not Verified" for `list` or `search` actions.**

---

## Safety Guard Against False Success

After `Book option N`:
1. Check `appointment_action == "booked"` and `appointment_verified == true` → show confirmed card.
2. If `appointment_verified == false` → show retry UI.
3. Optionally trigger auto "Show my upcoming appointments" for extra confidence.
4. **Do NOT show verification badges for list/search operations.**

---

## Testing Checklist (App Side)

- [ ] Search slots shows doctor names (no `Dr. TBC`).
- [ ] Booking success message includes doctor + time.
- [ ] Upcoming appointments list includes newly booked entry.
- [ ] Cancellation removes/updates appointment from upcoming list.
- [ ] Failure state shown when backend verification fails.
- [ ] Same `session_id` retained during one booking flow.
- [ ] Correct `patient_id` bound for all requests.

---

## Debug Tip

If app says "booked" but list is empty:
- first check `patient_id` mismatch in request payload,
- then check session continuity,
- then run a manual `Show my upcoming appointments` call in same session.

