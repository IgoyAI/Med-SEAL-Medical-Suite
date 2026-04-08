"""A4 Lifestyle Agent – FHIR tools.

Nutrition and lifestyle tools: patient condition/medication reads for
dietary context, biometrics, wellness goals, a local food database
(Southeast Asian dishes), drug–food interaction checks, and writers
for FHIR Goal and NutritionOrder resources.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
from datetime import datetime, timezone

from langchain_core.tools import tool

from agent.tools.fhir_client import get_medplum


def _run(coro):
    """Run an async coroutine from a sync LangChain tool context."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


# ------------------------------------------------------------------
# Local food database (V1 – common Southeast Asian dishes)
# ------------------------------------------------------------------

_SEA_FOOD_DB: dict[str, dict] = {
    "nasi lemak": {
        "calories": 644, "carbs_g": 72, "fat_g": 36, "protein_g": 17,
        "sodium_mg": 800, "glycemic_index": "high",
        "healthier_alternative": "Brown rice with sambal on the side, grilled chicken, extra cucumber",
    },
    "roti prata": {
        "calories": 302, "carbs_g": 36, "fat_g": 16, "protein_g": 6,
        "sodium_mg": 450, "glycemic_index": "high",
        "healthier_alternative": "Whole-wheat thosai with dhal, less oil",
    },
    "char kway teow": {
        "calories": 742, "carbs_g": 82, "fat_g": 38, "protein_g": 22,
        "sodium_mg": 1200, "glycemic_index": "high",
        "healthier_alternative": "Stir-fried bee hoon with more vegetables, less oil and sweet sauce",
    },
    "ban mian": {
        "calories": 475, "carbs_g": 58, "fat_g": 18, "protein_g": 22,
        "sodium_mg": 900, "glycemic_index": "medium",
        "healthier_alternative": "Soup-based ban mian with extra greens, less minced pork",
    },
    "thosai": {
        "calories": 120, "carbs_g": 18, "fat_g": 3, "protein_g": 4,
        "sodium_mg": 200, "glycemic_index": "low",
        "healthier_alternative": "Already a reasonable choice; pair with dhal instead of coconut chutney",
    },
    "mee siam": {
        "calories": 462, "carbs_g": 60, "fat_g": 18, "protein_g": 14,
        "sodium_mg": 1050, "glycemic_index": "medium",
        "healthier_alternative": "Request less gravy and tamarind sauce, add tofu and bean sprouts",
    },
    "chicken rice": {
        "calories": 607, "carbs_g": 73, "fat_g": 22, "protein_g": 28,
        "sodium_mg": 750, "glycemic_index": "high",
        "healthier_alternative": "Steamed (not roasted) chicken with brown rice, extra vegetables",
    },
    "laksa": {
        "calories": 589, "carbs_g": 55, "fat_g": 32, "protein_g": 24,
        "sodium_mg": 1400, "glycemic_index": "medium",
        "healthier_alternative": "Reduce coconut milk portion, add more tofu and bean sprouts",
    },
    "economy rice": {
        "calories": 550, "carbs_g": 65, "fat_g": 22, "protein_g": 25,
        "sodium_mg": 700, "glycemic_index": "high",
        "healthier_alternative": "Brown rice, steamed fish, two vegetable dishes, less gravy",
    },
    "yong tau foo": {
        "calories": 320, "carbs_g": 35, "fat_g": 12, "protein_g": 18,
        "sodium_mg": 650, "glycemic_index": "low",
        "healthier_alternative": "Soup base instead of laksa/curry, more vegetables, less fried items",
    },
}

_FOOD_DRUG_INTERACTIONS: dict[str, dict] = {
    "grapefruit": {
        "drugs": ["statins", "atorvastatin", "simvastatin", "lovastatin",
                  "calcium channel blockers", "amlodipine", "felodipine"],
        "effect": "Inhibits CYP3A4 enzyme, increasing drug concentration and risk of side effects",
        "severity": "high",
    },
    "potassium-rich foods": {
        "drugs": ["ACE inhibitors", "lisinopril", "enalapril", "ramipril",
                  "ARBs", "losartan", "valsartan", "potassium-sparing diuretics"],
        "effect": "May cause dangerous hyperkalaemia when combined with potassium-sparing medications",
        "severity": "high",
        "examples": "bananas, oranges, potatoes, spinach, coconut water",
    },
    "vitamin K-rich foods": {
        "drugs": ["warfarin", "coumadin"],
        "effect": "Reduces anticoagulant effectiveness; sudden intake changes alter INR",
        "severity": "high",
        "examples": "kale, spinach, broccoli, Brussels sprouts, natto",
    },
    "dairy products": {
        "drugs": ["tetracycline", "doxycycline", "ciprofloxacin",
                  "levofloxacin", "bisphosphonates", "alendronate"],
        "effect": "Calcium binds to drug molecules reducing absorption",
        "severity": "medium",
    },
    "caffeine": {
        "drugs": ["theophylline", "clozapine", "lithium"],
        "effect": "Increases drug levels or counteracts sedative effects",
        "severity": "medium",
    },
    "alcohol": {
        "drugs": ["metformin", "paracetamol", "acetaminophen", "methotrexate",
                  "benzodiazepines", "opioids", "antihistamines"],
        "effect": "Increases hepatotoxicity or CNS depression risk",
        "severity": "high",
    },
}


# ------------------------------------------------------------------
# Tools
# ------------------------------------------------------------------

@tool
def read_patient_conditions(patient_id: str) -> str:
    """Read active conditions for dietary constraint assessment.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        conditions = await medplum.search("Condition", {
            "patient": patient_id,
            "clinical-status": "active",
        })
        return json.dumps([
            {
                "id": c.get("id"),
                "code": c.get("code"),
                "clinicalStatus": c.get("clinicalStatus"),
                "onsetDateTime": c.get("onsetDateTime"),
            }
            for c in conditions
        ], default=str)
    return _run(_call())


@tool
def read_patient_medications(patient_id: str) -> str:
    """Read active medications for drug–food interaction assessment.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        meds = await medplum.search("MedicationRequest", {
            "patient": patient_id,
            "status": "active",
        })
        return json.dumps([
            {
                "id": m.get("id"),
                "medicationCodeableConcept": m.get("medicationCodeableConcept"),
                "dosageInstruction": m.get("dosageInstruction"),
            }
            for m in meds
        ], default=str)
    return _run(_call())


@tool
def read_latest_biometrics(patient_id: str) -> str:
    """Read latest weight, BMI, glucose, and HbA1c values.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    _CODES = {
        "29463-7": "Body Weight",
        "39156-5": "BMI",
        "2339-0":  "Glucose",
        "4548-4":  "HbA1c",
    }

    async def _call():
        medplum = get_medplum()
        results = {}
        for loinc, name in _CODES.items():
            obs = await medplum.search("Observation", {
                "patient": patient_id,
                "code": f"http://loinc.org|{loinc}",
                "_sort": "-date",
                "_count": "1",
            })
            if obs:
                vq = obs[0].get("valueQuantity", {})
                results[name] = {
                    "loinc": loinc,
                    "value": vq.get("value"),
                    "unit": vq.get("unit"),
                    "date": obs[0].get("effectiveDateTime"),
                }
            else:
                results[name] = None
        return json.dumps(results, default=str)
    return _run(_call())


@tool
def read_patient_goals(patient_id: str) -> str:
    """Read active wellness goals for the patient.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        goals = await medplum.search("Goal", {
            "patient": patient_id,
            "lifecycle-status": "active",
        })
        return json.dumps([
            {
                "id": g.get("id"),
                "description": g.get("description"),
                "target": g.get("target"),
                "lifecycleStatus": g.get("lifecycleStatus"),
                "achievementStatus": g.get("achievementStatus"),
                "startDate": g.get("startDate"),
                "statusDate": g.get("statusDate"),
            }
            for g in goals
        ], default=str)
    return _run(_call())


@tool
def query_food_database(query: str, dietary_constraints: str = "") -> str:
    """Query the local Southeast Asian food database for nutritional info
    and healthier alternatives.

    V1: Returns matches from a hardcoded dictionary of common hawker
    centre and kopitiam dishes.

    Args:
        query: Food name or keyword to search (e.g. 'nasi lemak').
        dietary_constraints: Optional comma-separated constraints
            (e.g. 'low-sodium,low-gi').
    """
    query_lower = query.lower().strip()
    constraints = [c.strip().lower() for c in dietary_constraints.split(",") if c.strip()]
    matches = []
    for name, info in _SEA_FOOD_DB.items():
        if query_lower in name or name in query_lower:
            entry = {"food": name, **info}
            warnings = []
            if "low-sodium" in constraints and info.get("sodium_mg", 0) > 600:
                warnings.append(f"High sodium ({info['sodium_mg']}mg)")
            if "low-gi" in constraints and info.get("glycemic_index") == "high":
                warnings.append("High glycemic index")
            if "low-fat" in constraints and info.get("fat_g", 0) > 20:
                warnings.append(f"High fat ({info['fat_g']}g)")
            if warnings:
                entry["dietary_warnings"] = warnings
            matches.append(entry)
    if not matches:
        return json.dumps({
            "query": query,
            "matches": [],
            "note": "Food not found in local database. Consider asking the patient for details.",
        })
    return json.dumps({"query": query, "matches": matches}, default=str)


@tool
def check_food_drug_interactions(
    food_items: str, medication_names: str
) -> str:
    """Check for food–drug interactions (V1 hardcoded knowledge base).

    Args:
        food_items: Comma-separated food names or categories.
        medication_names: Comma-separated medication names.
    """
    foods = [f.strip().lower() for f in food_items.split(",") if f.strip()]
    meds = [m.strip().lower() for m in medication_names.split(",") if m.strip()]
    interactions = []
    for food_cat, info in _FOOD_DRUG_INTERACTIONS.items():
        food_match = any(food_cat in f or f in food_cat for f in foods)
        drug_match = any(
            any(drug in m or m in drug for drug in info["drugs"])
            for m in meds
        )
        if food_match and drug_match:
            interactions.append({
                "food_category": food_cat,
                "matched_drugs": [
                    d for d in info["drugs"]
                    if any(d in m or m in d for m in meds)
                ],
                "effect": info["effect"],
                "severity": info["severity"],
            })
    return json.dumps({
        "foods_checked": foods,
        "medications_checked": meds,
        "interactions_found": len(interactions),
        "interactions": interactions,
    })


@tool
def write_goal(
    patient_id: str, description: str, target_value: str, due_date: str
) -> str:
    """Create a FHIR Goal resource for the patient.

    Args:
        patient_id: FHIR Patient resource ID.
        description: Goal description (e.g. 'Reduce HbA1c to below 7%').
        target_value: Target measure value (e.g. '7%', '70kg').
        due_date: Target due date in YYYY-MM-DD format.
    """
    async def _call():
        medplum = get_medplum()
        result = await medplum.create("Goal", {
            "resourceType": "Goal",
            "lifecycleStatus": "active",
            "subject": {"reference": f"Patient/{patient_id}"},
            "description": {"text": description},
            "target": [{
                "measure": {"text": target_value},
                "dueDate": due_date,
            }],
            "startDate": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        })
        return json.dumps({
            "id": result.get("id"),
            "lifecycleStatus": result.get("lifecycleStatus"),
            "description": description,
            "due_date": due_date,
        }, default=str)
    return _run(_call())


@tool
def write_nutrition_order(
    patient_id: str, diet_type: str, instructions: str
) -> str:
    """Create a FHIR NutritionOrder resource.

    Args:
        patient_id: FHIR Patient resource ID.
        diet_type: Diet type code (e.g. 'diabetic', 'low-sodium',
            'renal', 'general').
        instructions: Free-text dietary instructions.
    """
    async def _call():
        medplum = get_medplum()
        result = await medplum.create("NutritionOrder", {
            "resourceType": "NutritionOrder",
            "status": "active",
            "intent": "order",
            "patient": {"reference": f"Patient/{patient_id}"},
            "dateTime": datetime.now(timezone.utc).isoformat(),
            "oralDiet": {
                "type": [{
                    "coding": [{
                        "system": "http://snomed.info/sct",
                        "display": diet_type,
                    }],
                    "text": diet_type,
                }],
                "instruction": instructions,
            },
        })
        return json.dumps({
            "id": result.get("id"),
            "status": result.get("status"),
            "diet_type": diet_type,
        }, default=str)
    return _run(_call())


LIFESTYLE_FHIR_TOOLS = [
    read_patient_conditions,
    read_patient_medications,
    read_latest_biometrics,
    read_patient_goals,
    query_food_database,
    check_food_drug_interactions,
    write_goal,
    write_nutrition_order,
]
