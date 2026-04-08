"""Seed Medplum with Practitioners, Schedules, and Slots for appointment testing."""

import asyncio
from datetime import datetime, timedelta, timezone
from agent.tools.fhir_client import MedplumClient
from agent.config import settings


async def main():
    fhir = MedplumClient(
        base_url=settings.medplum_url,
        email=settings.medplum_email,
        password=settings.medplum_password,
    )

    practitioners = [
        {
            "resourceType": "Practitioner",
            "name": [{"given": ["Sarah"], "family": "Tan", "prefix": ["Dr"]}],
            "qualification": [{"code": {"text": "General Practitioner"}}],
        },
        {
            "resourceType": "Practitioner",
            "name": [{"given": ["Wei Ming"], "family": "Lim", "prefix": ["Dr"]}],
            "qualification": [{"code": {"text": "Cardiologist"}}],
        },
        {
            "resourceType": "Practitioner",
            "name": [{"given": ["Aisha"], "family": "Rahman", "prefix": ["Dr"]}],
            "qualification": [{"code": {"text": "Endocrinologist"}}],
        },
        {
            "resourceType": "Practitioner",
            "name": [{"given": ["Rajesh"], "family": "Kumar", "prefix": ["Dr"]}],
            "qualification": [{"code": {"text": "Nephrologist"}}],
        },
    ]

    specialties = [
        {"text": "General Practice", "coding": [{"system": "http://snomed.info/sct", "code": "394814009", "display": "General Practice"}]},
        {"text": "Cardiology", "coding": [{"system": "http://snomed.info/sct", "code": "394579002", "display": "Cardiology"}]},
        {"text": "Endocrinology", "coding": [{"system": "http://snomed.info/sct", "code": "394583002", "display": "Endocrinology"}]},
        {"text": "Nephrology", "coding": [{"system": "http://snomed.info/sct", "code": "394589003", "display": "Nephrology"}]},
    ]

    now = datetime.now(timezone.utc)
    created_practitioners = []
    created_schedules = []

    print("Creating practitioners...")
    for p in practitioners:
        result = await fhir.create("Practitioner", p)
        pid = result["id"]
        name = p["name"][0]["given"][0] + " " + p["name"][0]["family"]
        print(f"  Created Practitioner/{pid} — Dr {name}")
        created_practitioners.append(result)

    print("\nCreating schedules...")
    for i, pract in enumerate(created_practitioners):
        pract_id = pract["id"]
        pract_name = practitioners[i]["name"][0]["given"][0] + " " + practitioners[i]["name"][0]["family"]
        schedule = {
            "resourceType": "Schedule",
            "active": True,
            "actor": [{"reference": f"Practitioner/{pract_id}", "display": f"Dr {pract_name}"}],
            "specialty": [specialties[i]],
            "planningHorizon": {
                "start": now.isoformat(),
                "end": (now + timedelta(days=30)).isoformat(),
            },
        }
        result = await fhir.create("Schedule", schedule)
        print(f"  Created Schedule/{result['id']} for Dr {pract_name} ({specialties[i]['text']})")
        created_schedules.append(result)

    print("\nCreating slots...")
    slot_count = 0
    for i, sched in enumerate(created_schedules):
        sched_id = sched["id"]
        spec = specialties[i]
        for day_offset in range(1, 15):
            day = now + timedelta(days=day_offset)
            if day.weekday() >= 5:
                continue
            for hour in [9, 10, 11, 14, 15, 16]:
                slot_start = day.replace(hour=hour, minute=0, second=0, microsecond=0)
                slot_end = slot_start + timedelta(minutes=30)
                slot = {
                    "resourceType": "Slot",
                    "schedule": {"reference": f"Schedule/{sched_id}"},
                    "status": "free",
                    "start": slot_start.isoformat(),
                    "end": slot_end.isoformat(),
                    "serviceType": [spec],
                }
                await fhir.create("Slot", slot)
                slot_count += 1

    print(f"  Created {slot_count} free slots across {len(created_schedules)} schedules")

    print("\n--- Summary ---")
    for i, p in enumerate(created_practitioners):
        name = practitioners[i]["name"][0]["given"][0] + " " + practitioners[i]["name"][0]["family"]
        print(f"  Dr {name} ({specialties[i]['text']}) — Practitioner/{p['id']}")

    print(f"\nDone! {slot_count} appointment slots available for the next 2 weeks.")
    await fhir.close()


if __name__ == "__main__":
    asyncio.run(main())
