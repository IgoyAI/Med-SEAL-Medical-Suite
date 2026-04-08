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

## Safety Guard Against False Success

After `Book option N`:
1. Show temporary status: **"Confirming with clinic records..."**
2. Trigger auto "Show my upcoming appointments".
3. Promote to confirmed card only when appointment appears.
4. If not found in list, show:
   - "Booking could not be verified. Please retry."
   - action buttons: `Retry booking`, `Refresh appointments`.

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

