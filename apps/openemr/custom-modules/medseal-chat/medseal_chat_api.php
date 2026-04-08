<?php
/**
 * Med-SEAL AI Chat API — Connected to the real AI agent service
 * Handles chat thread management and routes messages to the LLM
 */

// Security check
if (!defined('OPENEMR_STARTUP_CHECK')) {
    define('OPENEMR_STARTUP_CHECK', true);
}

require_once(__DIR__ . '/../../../globals.php');
require_once($GLOBALS['srcdir'] . '/sql.inc.php');

header('Content-Type: application/json');

// Verify user is logged in
if (empty($_SESSION['authUserID'])) {
    echo json_encode(['success' => false, 'error' => 'Not authenticated']);
    exit;
}

$userId = (int)$_SESSION['authUserID'];
$action = $_POST['action'] ?? $_GET['action'] ?? '';

// AI Agent service URL (Docker internal network)
$AI_SERVICE_URL = 'https://medseal-agent-74997794842.asia-southeast1.run.app';

switch ($action) {
    // ═══ SEND MESSAGE ═══
    case 'send_message':
    case 'send':
        $threadId = (int)($_POST['thread_id'] ?? 0);
        $content = trim($_POST['content'] ?? '');
        if (!$threadId || !$content) {
            echo json_encode(['success' => false, 'error' => 'Missing thread_id or content']);
            break;
        }

        // Verify thread belongs to user
        $thread = sqlQuery(
            "SELECT t.*, p.fname, p.lname, p.DOB, p.sex
             FROM medseal_chat_threads t
             LEFT JOIN patient_data p ON t.pid = p.pid
             WHERE t.id = ? AND t.user_id = ?",
            [$threadId, $userId]
        );
        if (!$thread) {
            echo json_encode(['success' => false, 'error' => 'Thread not found']);
            break;
        }

        // Save user message
        sqlStatement(
            "INSERT INTO medseal_chat_messages (thread_id, role, content) VALUES (?, 'user', ?)",
            [$threadId, $content]
        );

        // Build patient context from OpenEMR data
        $pid = (int)$thread['pid'];
        $patientName = trim(($thread['fname'] ?? '') . ' ' . ($thread['lname'] ?? ''));
        $patient = buildPatientContext($pid, $patientName, $thread);

        // Get conversation history from this thread
        $history = [];
        $historyResult = sqlStatement(
            "SELECT role, content FROM medseal_chat_messages WHERE thread_id = ? ORDER BY id",
            [$threadId]
        );
        while ($row = sqlFetchArray($historyResult)) {
            if ($row['role'] !== 'system') {
                $history[] = ['role' => $row['role'], 'content' => $row['content']];
            }
        }

        // Call AI agent service
        $aiResponse = callAIAgent($patient, $content, $history);

        // Save AI response
        sqlStatement(
            "INSERT INTO medseal_chat_messages (thread_id, role, content) VALUES (?, 'assistant', ?)",
            [$threadId, $aiResponse]
        );

        echo json_encode(['success' => true, 'response' => $aiResponse]);
        break;

    // ═══ GET THREAD MESSAGES ═══
    case 'get_messages':
    case 'messages':
        $threadId = (int)($_GET['thread_id'] ?? 0);
        if (!$threadId) {
            echo json_encode(['success' => false, 'error' => 'Missing thread_id']);
            break;
        }
        $messages = [];
        $result = sqlStatement(
            "SELECT id, role, content, created_at FROM medseal_chat_messages WHERE thread_id = ? ORDER BY id",
            [$threadId]
        );
        while ($row = sqlFetchArray($result)) {
            $messages[] = $row;
        }
        echo json_encode(['success' => true, 'messages' => $messages]);
        break;

    // ═══ GET THREAD LIST ═══
    case 'get_threads':
    case 'threads':
        $threads = [];
        $result = sqlStatement(
            "SELECT t.id, t.pid, t.title, t.created_at, t.updated_at,
                    (SELECT COUNT(*) FROM medseal_chat_messages WHERE thread_id = t.id) as message_count
             FROM medseal_chat_threads t
             WHERE t.user_id = ?
             ORDER BY t.updated_at DESC",
            [$userId]
        );
        while ($row = sqlFetchArray($result)) {
            $threads[] = $row;
        }
        echo json_encode(['success' => true, 'threads' => $threads]);
        break;

    // ═══ CREATE THREAD (1 per patient) ═══
    case 'new_thread':
        $pid = (int)($_POST['pid'] ?? 0);
        if (!$pid) {
            echo json_encode(['success' => false, 'error' => 'Missing patient ID']);
            break;
        }

        // Check if a thread already exists for this patient+user
        $existing = sqlQuery(
            "SELECT id FROM medseal_chat_threads WHERE user_id = ? AND pid = ? LIMIT 1",
            [$userId, $pid]
        );
        if ($existing) {
            // Reuse existing thread
            echo json_encode(['success' => true, 'thread_id' => (int)$existing['id']]);
            break;
        }

        $patient = sqlQuery("SELECT fname, lname FROM patient_data WHERE pid = ?", [$pid]);
        if (!$patient) {
            echo json_encode(['success' => false, 'error' => 'Patient not found']);
            break;
        }
        $title = trim($patient['fname'] . ' ' . $patient['lname']);

        $threadId = sqlInsert(
            "INSERT INTO medseal_chat_threads (user_id, pid, title) VALUES (?, ?, ?)",
            [$userId, $pid, $title]
        );

        $welcome = "Hello, Dr. I'm your **Med-SEAL AI Clinical Assistant** for **{$title}**. I have access to this patient's complete medical record including:\n\n"
            . "• Medical history, conditions & diagnoses\n"
            . "• Current medications & allergies\n"
            . "• Recent encounters, vitals & lab results\n"
            . "• Treatment plans & clinical notes\n\n"
            . "How can I assist you today?";
        sqlStatement(
            "INSERT INTO medseal_chat_messages (thread_id, role, content) VALUES (?, 'assistant', ?)",
            [$threadId, $welcome]
        );

        echo json_encode(['success' => true, 'thread_id' => (int)$threadId]);
        break;

    // ═══ DELETE THREAD ═══
    case 'delete_thread':
    case 'delete':
        $threadId = (int)($_POST['thread_id'] ?? 0);
        if (!$threadId) {
            echo json_encode(['success' => false, 'error' => 'Missing thread_id']);
            break;
        }
        sqlStatement("DELETE FROM medseal_chat_messages WHERE thread_id = ?", [$threadId]);
        sqlStatement("DELETE FROM medseal_chat_threads WHERE id = ? AND user_id = ?", [$threadId, $userId]);
        echo json_encode(['success' => true]);
        break;

    default:
        echo json_encode(['success' => false, 'error' => 'Unknown action']);
}

// ════════════════════════════════════════════════
// Helper: Build patient context from OpenEMR data
// ════════════════════════════════════════════════
function buildPatientContext($pid, $patientName, $patientRow) {
    // Split name for buildClinicalContext compatibility
    $nameParts = explode(' ', $patientName, 2);
    $context = [
        'firstName' => $nameParts[0] ?? '',
        'lastName' => $nameParts[1] ?? '',
        'dateOfBirth' => $patientRow['DOB'] ?? '',
        'gender' => $patientRow['sex'] ?? '',
        'id' => (string)$pid,
    ];

    // Age
    if (!empty($patientRow['DOB'])) {
        $dob = new DateTime($patientRow['DOB']);
        $context['age'] = $dob->diff(new DateTime())->y;
    }

    // Active conditions (structured for buildClinicalContext)
    $conditions = [];
    $condResult = sqlStatement(
        "SELECT title, diagnosis, begdate FROM lists WHERE pid = ? AND type = 'medical_problem' AND activity = 1 ORDER BY begdate DESC LIMIT 20",
        [$pid]
    );
    while ($row = sqlFetchArray($condResult)) {
        $conditions[] = [
            'display' => $row['title'],
            'code' => $row['diagnosis'] ?? '',
            'clinicalStatus' => 'active',
            'onsetDate' => $row['begdate'] ?? '',
            'severity' => '',
        ];
    }
    $context['conditions'] = $conditions;

    // Medications (structured for buildClinicalContext)
    $medications = [];
    $medResult = sqlStatement(
        "SELECT title FROM lists WHERE pid = ? AND type = 'medication' AND activity = 1 ORDER BY begdate DESC LIMIT 15",
        [$pid]
    );
    while ($row = sqlFetchArray($medResult)) {
        $medications[] = [
            'display' => $row['title'],
            'code' => '',
            'status' => 'active',
            'dosage' => '',
            'frequency' => '',
            'route' => '',
        ];
    }
    $context['medications'] = $medications;

    // Allergies (structured for buildClinicalContext)
    $allergies = [];
    $allergyResult = sqlStatement(
        "SELECT title FROM lists WHERE pid = ? AND type = 'allergy' AND activity = 1 ORDER BY begdate DESC LIMIT 10",
        [$pid]
    );
    while ($row = sqlFetchArray($allergyResult)) {
        $allergies[] = [
            'display' => $row['title'],
            'code' => '',
            'category' => '',
            'criticality' => '',
            'clinicalStatus' => 'active',
        ];
    }
    $context['allergies'] = $allergies;

    // Recent encounters (structured for buildClinicalContext)
    $encounters = [];
    $encResult = sqlStatement(
        "SELECT fe.date, fe.reason FROM form_encounter fe WHERE fe.pid = ? ORDER BY fe.date DESC LIMIT 5",
        [$pid]
    );
    while ($row = sqlFetchArray($encResult)) {
        $encounters[] = [
            'date' => $row['date'],
            'classCode' => 'AMB',
            'reasonDesc' => $row['reason'] ?? 'Visit',
        ];
    }
    $context['encounters'] = $encounters;

    // Latest vitals as observations (structured for buildClinicalContext)
    $vitals = sqlQuery(
        "SELECT bps, bpd, pulse, respiration, temperature, weight, height, BMI, oxygen_saturation
         FROM form_vitals WHERE pid = ? ORDER BY id DESC LIMIT 1",
        [$pid]
    );
    if ($vitals) {
        $observations = [];
        $vitalMap = [
            'bps' => ['Systolic Blood Pressure', 'mmHg'],
            'bpd' => ['Diastolic Blood Pressure', 'mmHg'],
            'pulse' => ['Heart Rate', 'bpm'],
            'respiration' => ['Respiratory Rate', '/min'],
            'temperature' => ['Body Temperature', 'F'],
            'weight' => ['Body Weight', 'kg'],
            'height' => ['Body Height', 'cm'],
            'BMI' => ['BMI', 'kg/m2'],
            'oxygen_saturation' => ['Oxygen Saturation', '%'],
        ];
        foreach ($vitalMap as $key => [$label, $unit]) {
            if (!empty($vitals[$key])) {
                $observations[] = [
                    'display' => $label,
                    'code' => $key,
                    'value' => (float)$vitals[$key],
                    'unit' => $unit,
                    'category' => 'vital-signs',
                    'effectiveDate' => date('Y-m-d'),
                ];
            }
        }
        $context['observations'] = $observations;
    }

    return $context;
}

// ════════════════════════════════════════════════
// Helper: Call AI Agent Service
// ════════════════════════════════════════════════
function callAIAgent($patient, $message, $history) {
    global $AI_SERVICE_URL;

    $payload = json_encode([
        'patient' => $patient,
        'message' => $message,
        'history' => array_slice($history, -20), // Last 20 messages for context
    ]);

    $ch = curl_init("{$AI_SERVICE_URL}/chat");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $payload,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 60, // 60s timeout for LLM response
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($error) {
        error_log("[Med-SEAL Chat] cURL error: {$error}");
        return "I'm sorry, I couldn't connect to the AI service. Error: {$error}\n\nPlease try again in a moment.";
    }

    if ($httpCode !== 200) {
        error_log("[Med-SEAL Chat] AI service returned HTTP {$httpCode}: {$response}");
        return "I'm sorry, the AI service returned an error (HTTP {$httpCode}). Please try again.";
    }

    $data = json_decode($response, true);
    if (!$data || !isset($data['response'])) {
        error_log("[Med-SEAL Chat] Invalid AI response: {$response}");
        return "I received an unexpected response from the AI service. Please try again.";
    }

    // Strip chain-of-thought / <think> blocks from response
    $result = $data['response'];
    $result = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $result);
    // If </think> exists without opening tag, strip everything before it
    $thinkEnd = strpos($result, '</think>');
    if ($thinkEnd !== false) {
        $result = substr($result, $thinkEnd + strlen('</think>'));
    }
    return trim($result);
}
