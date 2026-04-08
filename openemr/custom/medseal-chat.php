<?php
/**
 * Med-SEAL Chat - AI Clinical Assistant
 * Patient-linked, 1 patient = 1 chat thread
 *
 * @package   OpenEMR
 * @link      https://medseal.com
 */

require_once("../globals.php");

use OpenEMR\Core\Header;

// ═══ Cloud Run Agent Proxy (avoids CORS) ═══
$CLOUD_RUN_AGENT = 'https://medseal-agent-74997794842.asia-southeast1.run.app';

if (isset($_GET['action'])) {
    $action = $_GET['action'];
    header('Content-Type: application/json');

    // Proxy: Create session
    if ($action === 'proxy_session') {
        $ch = curl_init("$CLOUD_RUN_AGENT/sessions");
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => '',
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 15,
        ]);
        $resp = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        http_response_code($code ?: 502);
        echo $resp ?: json_encode(['error' => 'Agent unreachable']);
        exit;
    }

    // Proxy: Doctor chat (sync)
    if ($action === 'proxy_chat') {
        $sessionId = $_GET['session_id'] ?? '';
        $input = file_get_contents('php://input');
        $ch = curl_init("$CLOUD_RUN_AGENT/openemr/sessions/$sessionId/chat/sync");
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $input,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 120,
            CURLOPT_CONNECTTIMEOUT => 10,
        ]);
        $resp = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        if ($error) {
            http_response_code(502);
            echo json_encode(['error' => "Agent unreachable: $error"]);
        } else {
            http_response_code($code ?: 502);
            echo $resp ?: json_encode(['error' => 'Empty response from agent']);
        }
        exit;
    }

    // Proxy: Health check
    if ($action === 'proxy_health') {
        $ch = curl_init("$CLOUD_RUN_AGENT/health");
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 10,
        ]);
        $resp = curl_exec($ch);
        curl_close($ch);
        echo $resp ?: json_encode(['error' => 'Agent unreachable']);
        exit;
    }

    // Handle AJAX patient context query
    if ($action === 'get_patient') {
    $pid = $_SESSION['pid'] ?? 0;
    $meta = ['pid' => (int)$pid, 'name' => '', 'dob' => ''];
    if ($pid > 0) {
        $prow = sqlQuery(
            "SELECT uuid, pubpid, fname, lname, mname, DOB, sex, ss, phone_home, phone_cell, phone_biz, city, state, country_code FROM patient_data WHERE pid = ?",
            [$pid]
        );
        if ($prow) {
            $meta['name']     = trim(($prow['fname'] ?? '') . ' ' . ($prow['lname'] ?? ''));
            $meta['dob']      = $prow['DOB'] ?? '';
            $meta['uuid']     = $prow['uuid'] ?? '';
            $meta['pubpid']   = $prow['pubpid'] ?? '';
            $meta['sex']      = $prow['sex'] ?? '';
            $meta['ssn']      = $prow['ss'] ?? '';
            $meta['phone']    = $prow['phone_cell'] ?: ($prow['phone_home'] ?: ($prow['phone_biz'] ?? ''));
            $meta['city']     = $prow['city'] ?? '';
            $meta['state']    = $prow['state'] ?? '';
            $meta['country']  = $prow['country_code'] ?? '';
        }
    }
        echo json_encode($meta);
        exit;
    }

    // Unknown action
    http_response_code(400);
    echo json_encode(['error' => 'Unknown action']);
    exit;
}

// Get current patient context
$patientPid = $_SESSION['pid'] ?? 0;
$patientName = '';
$patientDOB = '';
if ($patientPid > 0) {
    $prow = sqlQuery(
        "SELECT uuid, pubpid, fname, lname, DOB, sex, ss, phone_home, phone_cell, city, state FROM patient_data WHERE pid = ?",
        [$patientPid]
    );
    if ($prow) {
        $patientName = trim(($prow['fname'] ?? '') . ' ' . ($prow['lname'] ?? ''));
        $patientDOB = $prow['DOB'] ?? '';
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <?php Header::setupHeader(); ?>
    <title><?php echo xlt('Med-SEAL Chat'); ?></title>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        :root {
            --sidebar-w: 280px;
            --sidebar-collapsed: 0px;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: #ffffff !important;
            height: 100vh;
            overflow: hidden;
        }

        .app { display: flex; height: 100vh; position: relative; background: #ffffff !important; }

        /* ═══ Sidebar ═══ */
        .sidebar {
            width: var(--sidebar-w);
            min-width: var(--sidebar-w);
            background: #ffffff;
            border-right: 1px solid var(--ms-border, #e2e5e9);
            display: flex;
            flex-direction: column;
            transition: width 0.35s cubic-bezier(0.34, 1.56, 0.64, 1),
                        min-width 0.35s cubic-bezier(0.34, 1.56, 0.64, 1),
                        opacity 0.2s ease;
            overflow: hidden;
            position: relative;
            z-index: 2;
        }

        .sidebar.collapsed {
            width: 0px;
            min-width: 0px;
            border-right: none;
        }

        .sidebar.collapsed .sidebar-inner { opacity: 0; pointer-events: none; }

        .sidebar-inner {
            display: flex;
            flex-direction: column;
            height: 100%;
            width: var(--sidebar-w);
            transition: opacity 0.15s ease;
        }

        .sidebar-header {
            padding: 14px;
            border-bottom: 1px solid var(--ms-border, #e2e5e9);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .new-chat-btn {
            flex: 1;
            padding: 8px 12px;
            background: var(--ms-primary, #4f6bed);
            border: none;
            border-radius: 6px;
            color: #fff;
            font-family: 'Inter', sans-serif;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: background 0.15s;
        }
        .new-chat-btn:hover { background: #3d57d4; }
        .new-chat-btn:disabled { background: #c5cad3; cursor: not-allowed; }

        .collapse-btn {
            width: 32px; height: 32px;
            border-radius: 6px;
            border: 1px solid var(--ms-border, #e2e5e9);
            background: #fff;
            color: var(--ms-text-tertiary, #8a8f98);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            transition: all 0.15s;
            flex-shrink: 0;
        }
        .collapse-btn:hover { color: var(--ms-primary); border-color: var(--ms-primary); }

        .section-label {
            padding: 14px 16px 6px;
            font-size: 10px;
            font-weight: 700;
            color: var(--ms-text-tertiary, #8a8f98);
            text-transform: uppercase;
            letter-spacing: 0.06em;
        }

        .chat-list {
            flex: 1;
            overflow-y: auto;
            padding: 4px 8px;
        }

        .chat-item {
            padding: 10px 14px;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            margin-bottom: 2px;
            border: 1px solid transparent;
        }
        .chat-item:hover { 
            background: #f8f9fc;
            transform: translateX(2px);
        }
        .chat-item.active {
            background: var(--ms-primary-50, #eef1fd);
            border-color: var(--ms-primary, #4f6bed);
        }

        .chat-item-name {
            font-size: 12.5px;
            font-weight: 600;
            color: var(--ms-text-primary, #1a1d21);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-bottom: 2px;
        }
        .chat-item.active .chat-item-name { color: var(--ms-primary); }

        .chat-item-meta {
            font-size: 11px;
            color: var(--ms-text-tertiary, #8a8f98);
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .chat-item-pid {
            background: #f0f2f5;
            padding: 1px 5px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: 600;
        }

        .sidebar-footer {
            padding: 10px 14px;
            border-top: 1px solid var(--ms-border, #e2e5e9);
            font-size: 10px;
            color: var(--ms-text-tertiary);
            text-align: center;
            font-weight: 500;
        }

        /* ═══ Expand button (visible when collapsed) ═══ */
        .expand-btn {
            position: absolute;
            top: 14px;
            left: 14px;
            z-index: 10;
            width: 32px; height: 32px;
            border-radius: 6px;
            border: 1px solid var(--ms-border, #e2e5e9);
            background: #fff;
            color: var(--ms-text-tertiary);
            cursor: pointer;
            display: none;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
            transition: all 0.15s;
        }
        .expand-btn:hover { color: var(--ms-primary); border-color: var(--ms-primary); }
        .sidebar.collapsed ~ .main .expand-btn { display: flex; }

        /* ═══ Main ═══ */
        .main {
            flex: 1;
            display: flex;
            flex-direction: column;
            background: #ffffff !important;
            position: relative;
            min-width: 0;
        }

        /* ═══ Patient Bar ═══ */
        .patient-bar {
            padding: 8px 16px 8px 56px;
            background: #fff;
            border-bottom: 1px solid var(--ms-border, #e2e5e9);
            display: flex;
            align-items: center;
            gap: 10px;
            min-height: 44px;
        }

        .patient-bar-avatar {
            width: 28px; height: 28px;
            border-radius: 6px;
            background: var(--ms-primary, #4f6bed);
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: 700;
            flex-shrink: 0;
        }

        .patient-bar-info {
            flex: 1;
            min-width: 0;
        }

        .patient-bar-name {
            font-size: 13px;
            font-weight: 600;
            color: var(--ms-text-primary, #1a1d21);
        }

        .patient-bar-detail {
            font-size: 11px;
            color: var(--ms-text-tertiary, #8a8f98);
        }

        .patient-bar-badge {
            padding: 4px 10px;
            background: rgba(79, 107, 237, 0.08);
            border: 1px solid rgba(79, 107, 237, 0.15);
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            color: var(--ms-primary, #4f6bed);
            letter-spacing: 0.02em;
        }

        /* ═══ Messages (Gemini/ChatGPT strict UI) ═══ */
        .messages { flex: 1; overflow-y: auto; padding: 32px 24px; display: flex; flex-direction: column; gap: 24px; background: #ffffff !important; }

        .msg-row { display: flex; gap: 16px; max-width: 90%; animation: fadeIn 0.25s ease; }
        .msg-row.user { align-self: flex-end; flex-direction: row-reverse; }
        .msg-row.assistant { align-self: flex-start; max-width: 85%; }

        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

        .msg-avatar {
            width: 30px; height: 30px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 13px; font-weight: 700; flex-shrink: 0; margin-top: 2px;
        }
        .msg-avatar.user-av { display: none; /* Modern AI chats don't show user avatar */ }
        .msg-avatar.ai-av { background: #ffffff; color: var(--ms-primary, #4f6bed); border: 1px solid var(--ms-border, #e2e5e9); box-shadow: 0 1px 2px rgba(0,0,0,0.03); }

        .msg-bubble { min-width: 0; flex: 1; display: flex; flex-direction: column; }
        .msg-row.user .msg-bubble { align-items: flex-end; }
        .msg-row.assistant .msg-bubble { align-items: flex-start; padding-top: 4px; }
        
        .msg-name { display: none; /* Hide names entirely for cleaner UI */ }

        .msg-text {
            font-size: 14.5px;
            line-height: 1.65;
            word-wrap: break-word;
            color: var(--ms-text-primary, #1a1d21);
        }

        /* User Message: Pill-shaped bubble */
        .msg-row.user .msg-text {
            background: #f4f4f4;
            color: var(--ms-text-primary, #1a1d21);
            padding: 10px 18px;
            border-radius: 20px;
            border-bottom-right-radius: 4px;
            display: inline-block;
        }

        /* AI Message: Plain text block (no bubble) */
        .msg-row.assistant .msg-text {
            background: transparent;
            border: none;
            box-shadow: none;
            padding: 0;
            max-width: 100%;
        }

        /* Markdown inside AI bubble */
        .msg-text p { margin-bottom: 8px; }
        .msg-text p:last-child { margin-bottom: 0; }
        .msg-text ul, .msg-text ol { padding-left: 18px; margin-bottom: 8px; }
        .msg-text li { margin-bottom: 2px; }
        .msg-text strong { font-weight: 600; }
        .msg-row.assistant .msg-text code { background: rgba(79,107,237,0.08); padding: 1px 5px; border-radius: 3px; font-size: 12px; font-family: 'SF Mono', Monaco, monospace; color: var(--ms-primary); }
        .msg-row.user .msg-text code { background: rgba(255,255,255,0.2); padding: 1px 5px; border-radius: 3px; font-size: 12px; font-family: 'SF Mono', Monaco, monospace; }
        .msg-text pre { background: #1e293b; color: #e2e8f0; padding: 10px; border-radius: 8px; overflow-x: auto; margin: 8px 0; }
        .msg-text pre code { background: none; padding: 0; color: inherit; }
        .msg-text blockquote { border-left: 3px solid var(--ms-primary); padding: 6px 12px; margin: 8px 0; background: rgba(79,107,237,0.05); border-radius: 0 6px 6px 0; }
        .msg-text table { border-collapse: collapse; width: 100%; margin: 8px 0; }
        .msg-text th, .msg-text td { border: 1px solid var(--ms-border); padding: 5px 8px; text-align: left; font-size: 12px; }
        .msg-text th { background: #f5f6f8; font-weight: 600; }

        /* ═══ Welcome ═══ */
        .welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px; }
        .welcome-icon { width: 44px; height: 44px; border-radius: 10px; background: var(--ms-primary); display: flex; align-items: center; justify-content: center; margin-bottom: 14px; }
        .welcome-icon i { font-size: 20px; color: #fff; }
        .welcome h1 { font-size: 18px; font-weight: 700; color: var(--ms-text-primary); margin-bottom: 4px; }
        .welcome p { font-size: 12.5px; color: var(--ms-text-tertiary); margin-bottom: 20px; text-align: center; max-width: 400px; }
        .welcome .model-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; background: var(--ms-primary-50); border: 1px solid var(--ms-border); border-radius: 4px; font-size: 10px; font-weight: 600; color: var(--ms-primary); margin-bottom: 18px; }
        .welcome .model-badge::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--ms-primary); }

        .no-patient {
            flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px;
        }
        .no-patient-icon { width: 44px; height: 44px; border-radius: 10px; background: #fee2e2; display: flex; align-items: center; justify-content: center; margin-bottom: 14px; }
        .no-patient-icon i { font-size: 20px; color: #dc2626; }
        .no-patient h2 { font-size: 16px; font-weight: 600; color: var(--ms-text-primary); margin-bottom: 4px; }
        .no-patient p { font-size: 12.5px; color: var(--ms-text-tertiary); text-align: center; max-width: 320px; }

        .suggestions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; max-width: 500px; width: 100%; margin-top: 10px; }
        .suggestion { 
            padding: 14px 16px; 
            border: 1px solid var(--ms-border); 
            border-radius: 12px; 
            font-size: 12.5px; 
            color: var(--ms-text-secondary); 
            cursor: pointer; 
            transition: all 0.2s ease; 
            line-height: 1.5; 
            text-align: left; 
            background: #fff;
            box-shadow: 0 1px 2px rgba(0,0,0,0.02);
        }
        .suggestion:hover { 
            border-color: var(--ms-primary); 
            background: var(--ms-primary-50);
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(79, 107, 237, 0.08);
        }
        .suggestion span { display: block; font-weight: 600; color: var(--ms-text-primary); margin-bottom: 4px; font-size: 13px; }

        /* ═══ Input (Gemini-style rich) ═══ */
        .input-area {
            padding: 10px 16px 14px;
            background: transparent !important;
        }
        .input-container { max-width: 768px; margin: 0 auto; position: relative; }

        .attach-preview {
            display: flex; gap: 8px; padding: 8px 16px 0; flex-wrap: wrap;
        }
        .attach-preview:empty { display: none; }
        .attach-thumb {
            position: relative; width: 60px; height: 60px; border-radius: 10px;
            overflow: hidden; border: 1px solid rgba(0,0,0,0.08);
            animation: fadeIn 0.2s ease;
        }
        .attach-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .attach-thumb-remove {
            position: absolute; top: 3px; right: 3px; width: 18px; height: 18px;
            border-radius: 50%; background: rgba(0,0,0,0.6); color: #fff;
            border: none; cursor: pointer; font-size: 9px;
            display: flex; align-items: center; justify-content: center;
        }
        .attach-thumb-remove:hover { background: #dc2626; }

        .input-box {
            display: flex;
            flex-direction: column;
            background: var(--ms-primary-50, #eef1fd) !important;
            border: 1px solid var(--ms-border, #e2e5e9) !important;
            border-radius: 24px !important;
            transition: border-color 0.2s;
            cursor: text;
        }
        .input-box:focus-within {
            border-color: var(--ms-primary, #4f6bed) !important;
        }

        .rich-input {
            width: 100%;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif !important;
            font-size: 14.5px !important;
            color: var(--ms-text-primary, #1a1d21) !important;
            outline: none !important;
            min-height: 24px;
            max-height: 200px;
            overflow-y: auto;
            line-height: 1.5;
            padding: 16px 18px 4px 18px !important;
            word-wrap: break-word;
            white-space: pre-wrap;
        }
        .rich-input[empty="true"]:before {
            content: attr(placeholder);
            color: var(--ms-text-tertiary, #8a8f98) !important;
            pointer-events: none;
            display: block; /* For Firefox */
        }
        .rich-input[disabled="true"] {
            cursor: not-allowed; opacity: 0.5;
        }

        .input-toolbar {
            display: flex;
            align-items: center;
            padding: 4px 8px 6px 12px !important;
            gap: 2px;
        }

        .input-toolbar .toolbar-left {
            display: flex; align-items: center; gap: 4px; flex: 1;
        }
        .input-toolbar .toolbar-right {
            display: flex; align-items: center; gap: 8px;
        }

        .toolbar-icon-btn {
            width: 32px !important; height: 32px !important;
            border-radius: 50% !important; border: none !important;
            background: transparent !important;
            color: var(--ms-text-secondary, #555) !important;
            cursor: pointer !important;
            display: flex !important; align-items: center !important; justify-content: center !important;
            transition: all 0.12s !important;
            font-size: 16px !important;
            padding: 0 !important; margin: 0 !important;
            box-shadow: none !important;
        }
        .toolbar-icon-btn:hover {
            background: rgba(79, 107, 237, 0.08) !important;
            color: var(--ms-primary, #4f6bed) !important;
        }
        .toolbar-icon-btn:disabled { cursor: not-allowed !important; opacity: 0.35 !important; }

        .toolbar-text-btn {
            height: 32px !important; border-radius: 16px !important; border: 1px solid var(--ms-border, #e2e5e9) !important;
            background: #fff !important;
            color: var(--ms-text-secondary, #555) !important;
            cursor: pointer !important;
            display: inline-flex !important; align-items: center !important; justify-content: center !important;
            gap: 6px !important;
            transition: all 0.12s !important;
            font-family: 'Inter', sans-serif !important;
            font-size: 12.5px !important; font-weight: 500 !important;
            padding: 0 12px !important; margin: 0 !important;
            box-shadow: 0 1px 2px rgba(0,0,0,0.02) !important;
        }
        .toolbar-text-btn i { font-size: 14px !important; color: var(--ms-primary, #4f6bed) !important; }
        .toolbar-text-btn:hover { background: #f8f9fa !important; border-color: #d1d5db !important; }
        .toolbar-text-btn:disabled { cursor: not-allowed !important; opacity: 0.35 !important; }

        .send-btn {
            width: 36px !important; height: 36px !important; 
            border-radius: 50% !important; border: none !important;
            background: var(--ms-primary, #4f6bed) !important; color: #fff !important;
            cursor: pointer !important; display: flex !important; align-items: center !important; justify-content: center !important;
            transition: all 0.15s !important; font-size: 14px !important;
            padding: 0 !important; margin: 0 !important;
            box-shadow: 0 1px 4px rgba(79, 107, 237, 0.3) !important;
        }
        .send-btn:hover { background: #3d57d4 !important; transform: translateY(-1px) !important; }
        .send-btn:disabled {
            background: #d1d5db !important; color: #fff !important; cursor: not-allowed !important;
            box-shadow: none !important; transform: none !important;
        }

        .input-footer { text-align: center; font-size: 11px; color: var(--ms-text-tertiary, #9b9b9b); margin-top: 8px; }

        /* Image in bubble */
        .msg-images { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
        .msg-images img {
            max-width: 220px; max-height: 180px; border-radius: 10px;
            object-fit: cover; cursor: pointer; transition: opacity 0.12s;
        }
        .msg-images img:hover { opacity: 0.85; }

        /* ═══ Thinking ═══ */
        .thinking { display: flex; gap: 4px; padding: 4px 0; }
        .thinking span { width: 5px; height: 5px; border-radius: 50%; background: var(--ms-primary); animation: bounce 1.2s infinite; }
        .thinking span:nth-child(2) { animation-delay: 0.2s; }
        .thinking span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.3; } 30% { transform: translateY(-5px); opacity: 1; } }

        /* scrollbar */
        .messages::-webkit-scrollbar, .chat-list::-webkit-scrollbar { width: 4px; }
        .messages::-webkit-scrollbar-track, .chat-list::-webkit-scrollbar-track { background: transparent; }
        .messages::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 2px; }
        .chat-list::-webkit-scrollbar-thumb { background: #e5e7eb; border-radius: 2px; }
    </style>
</head>
<body>
    <div class="app">
        <!-- Sidebar -->
        <div class="sidebar" id="sidebar">
            <div class="sidebar-inner">
                <div class="sidebar-header">
                    <button class="new-chat-btn" id="newChatBtn" onclick="newChat()" <?php if ($patientPid <= 0) echo 'disabled title="Select a patient first"'; ?>>
                        <i class="fa fa-plus"></i> New Chat
                    </button>
                    <button class="collapse-btn" onclick="toggleSidebar()" title="Collapse sidebar">
                        <i class="fa fa-chevron-left"></i>
                    </button>
                </div>
                <div class="section-label">Patient Chats</div>
                <div class="chat-list" id="chatList"></div>
                <div class="sidebar-footer">Med-SEAL AI &middot; med-r1</div>
            </div>
        </div>

        <!-- Main -->
        <div class="main">
            <button class="expand-btn" onclick="toggleSidebar()" title="Expand sidebar">
                <i class="fa fa-chevron-right"></i>
            </button>

            <!-- Patient context bar -->
            <?php if ($patientPid > 0): ?>
            <div class="patient-bar">
                <div class="patient-bar-avatar"><?php echo strtoupper(substr($patientName, 0, 1)); ?></div>
                <div class="patient-bar-info">
                    <div class="patient-bar-name"><?php echo text($patientName); ?></div>
                    <div class="patient-bar-detail">PID: <?php echo text($patientPid); ?><?php if ($patientDOB) echo ' &middot; DOB: ' . text($patientDOB); ?></div>
                </div>
                <div class="patient-bar-badge">med-r1</div>
            </div>
            <?php endif; ?>

            <div class="messages" id="messages">
                <?php if ($patientPid <= 0): ?>
                <div class="no-patient" id="noPatient">
                    <div class="no-patient-icon"><i class="fa fa-user-times"></i></div>
                    <h2>No Patient Selected</h2>
                    <p>Select a patient from the Patient menu first, then return here to start an AI-assisted clinical chat.</p>
                </div>
                <?php else: ?>
                <div class="welcome" id="welcome">
                    <div class="welcome-icon"><i class="fa fa-stethoscope"></i></div>
                    <h1>Med-SEAL AI</h1>
                    <p>Clinical AI assistant for <strong><?php echo text($patientName); ?></strong>. Ask questions about this patient's data, get clinical decision support, or generate reports.</p>
                    <div class="model-badge">med-r1</div>
                    <div class="suggestions">
                        <div class="suggestion" onclick="askSuggestion(this)"><span>Clinical Summary</span>Summarize this patient's clinical data</div>
                        <div class="suggestion" onclick="askSuggestion(this)"><span>Drug Interactions</span>Check medication interactions</div>
                        <div class="suggestion" onclick="askSuggestion(this)"><span>Lab Analysis</span>Interpret latest lab results</div>
                        <div class="suggestion" onclick="askSuggestion(this)"><span>Care Recommendations</span>Suggest next steps in treatment</div>
                    </div>
                </div>
                <?php endif; ?>
            </div>

            <div class="input-area">
                <div class="input-container">
                    <div class="attach-preview" id="attachPreview"></div>
                    <div class="input-box" onclick="document.getElementById('userInput').focus()">
                        <div id="userInput" class="rich-input" contenteditable="true"
                             empty="true"
                             placeholder="<?php echo $patientPid > 0 ? 'Ask about ' . attr($patientName) . '...' : 'Select a patient to start chatting...'; ?>"></div>
                        <div class="input-toolbar">
                            <div class="toolbar-left">
                                <button class="toolbar-icon-btn" id="attachBtn" onclick="document.getElementById('fileInput').click()" title="Attach image" <?php if ($patientPid <= 0) echo 'disabled'; ?>>
                                    <i class="fa fa-paperclip"></i>
                                </button>
                                <button class="toolbar-text-btn" id="analyzeBtn" onclick="document.getElementById('fileInput').click()" <?php if ($patientPid <= 0) echo 'disabled'; ?>>
                                    <i class="fa fa-image"></i> Analyze Image
                                </button>
                            </div>
                            <div class="toolbar-right">
                                <button class="send-btn" id="sendBtn" onclick="send()" <?php if ($patientPid <= 0) echo 'disabled'; ?>><i class="fa fa-arrow-up"></i></button>
                            </div>
                        </div>
                    </div>
                    <input type="file" id="fileInput" accept="image/*" multiple style="display:none" onchange="handleFiles(this)">
                    <div class="input-footer">Med-SEAL AI may produce inaccurate information. Always verify clinically.</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // Use PHP proxy to avoid CORS — calls medseal_chat.php?action=proxy_*
        const AGENT_PROXY = 'medseal_chat.php';
        const USER = <?php echo json_encode($_SESSION['authUser'] ?? 'Clinician'); ?>;
        let PID = <?php echo json_encode($patientPid); ?>;
        let PNAME = <?php echo json_encode($patientName); ?>;
        const STORAGE = 'medseal_agent_chats_v3';

        // Full patient identifier bundle sent with every message
        let PATIENT_META = {
            pid: PID,
            name: PNAME,
            dob: '', sex: '', phone: '', pubpid: '', uuid: '', city: '', state: ''
        };

        let chats = [], activeChatId = null, busy = false;

        // ── Live patient context polling (detects patient selection in parent frame) ──
        async function pollPatient() {
            try {
                const res = await fetch('medseal_chat.php?action=get_patient', { credentials: 'same-origin' });
                if (!res.ok) return;
                const data = await res.json();
                if (data.pid !== PID) {
                    const oldPid = PID;
                    PID = data.pid;
                    PNAME = data.name || '';
                    // Store full patient identifiers
                    PATIENT_META = data;
                    onPatientChanged(oldPid);
                }
            } catch(e) { /* ignore */ }
        }

        function onPatientChanged(oldPid) {
            // Update patient bar
            const bar = document.getElementById('patientBar');
            const barAvatar = document.getElementById('patientBarAvatar');
            const barName = document.getElementById('patientBarName');
            const barDetail = document.getElementById('patientBarDetail');
            const barBadge = document.getElementById('patientBarBadge');
            const newChatBtn = document.getElementById('newChatBtn');
            const noPatientDiv = document.getElementById('noPatient');

            if (PID > 0) {
                if (barAvatar) barAvatar.textContent = PNAME.charAt(0).toUpperCase();
                if (barName) barName.textContent = PNAME;
                if (barDetail) barDetail.textContent = 'PID: ' + PID;
                if (barBadge) barBadge.textContent = 'med-r1';
                if (newChatBtn) { newChatBtn.disabled = false; newChatBtn.title = ''; }
                if (noPatientDiv) noPatientDiv.remove();

                // Enable the input
                const inp = document.getElementById('userInput');
                if (inp) {
                    inp.contentEditable = 'true';
                    inp.removeAttribute('disabled');
                    inp.setAttribute('placeholder', 'Ask about ' + PNAME + '...');
                }
                const attachBtn = document.getElementById('attachBtn');
                const analyzeBtn = document.getElementById('analyzeBtn');
                if (attachBtn) attachBtn.disabled = false;
                if (analyzeBtn) analyzeBtn.disabled = false;

                // Auto-load or show welcome for this patient
                const existing = chats.find(c => c.pid == PID);
                if (existing) {
                    loadChat(existing.id);
                } else {
                    document.getElementById('messages').innerHTML = '';
                    showWelcome();
                    document.getElementById('userInput').focus();
                }
            } else {
                if (newChatBtn) { newChatBtn.disabled = true; newChatBtn.title = 'Select a patient first'; }
            }
        }

        function init() {
            const s = localStorage.getItem(STORAGE);
            if (s) try { chats = JSON.parse(s); } catch(e) { chats = []; }
            renderList();
            // Auto-load chat for current patient if exists
            if (PID > 0) {
                const existing = chats.find(c => c.pid == PID);
                if (existing) loadChat(existing.id);
            }
            if (PID > 0) document.getElementById('userInput').focus();
            // Start polling for patient changes (every 2s)
            setInterval(pollPatient, 2000);
        }

        function save() { localStorage.setItem(STORAGE, JSON.stringify(chats)); }

        // ── Sidebar toggle ──
        function toggleSidebar() {
            document.getElementById('sidebar').classList.toggle('collapsed');
        }

        // ── New Chat (1 patient = 1 session) ──
        async function newChat() {
            if (PID <= 0) return;
            // Check if patient already has a chat
            let existing = chats.find(c => c.pid == PID);
            if (existing) {
                loadChat(existing.id);
                return;
            }

            // Try to create session with Agent Orchestrator, fallback to local ID
            try {
                const res = await fetch(`${AGENT_PROXY}?action=proxy_session`, { 
                    method: 'POST',
                    credentials: 'same-origin'
                });
                if (!res.ok) throw new Error('Session failed');
                const data = await res.json();
                
                const chat = {
                    id: data.session_id || ('local_' + Date.now()),
                    pid: PID,
                    name: PNAME,
                    messages: [],
                    created: new Date().toISOString()
                };
                chats.unshift(chat);
                activeChatId = chat.id;
            } catch (e) {
                // Agent API unreachable — create a local session and let it fail on send
                const chat = {
                    id: 'local_' + Date.now(),
                    pid: PID,
                    name: PNAME,
                    messages: [],
                    created: new Date().toISOString()
                };
                chats.unshift(chat);
                activeChatId = chat.id;
            }
            save();
            renderList();
            showWelcome();
            document.getElementById('userInput').focus();
        }

        function showWelcome() {
            document.getElementById('messages').innerHTML = `
                <div class="welcome" id="welcome">
                    <div class="welcome-icon"><i class="fa fa-stethoscope"></i></div>
                    <h1>Med-SEAL AI</h1>
                    <p>Clinical AI assistant for <strong>${esc(PNAME)}</strong>. Ask questions about this patient's data, get clinical decision support, or generate reports.</p>
                    <div class="model-badge">med-r1</div>
                    <div class="suggestions">
                        <div class="suggestion" onclick="askSuggestion(this)"><span>Clinical Summary</span>Summarize this patient's clinical data</div>
                        <div class="suggestion" onclick="askSuggestion(this)"><span>Drug Interactions</span>Check medication interactions</div>
                        <div class="suggestion" onclick="askSuggestion(this)"><span>Lab Analysis</span>Interpret latest lab results</div>
                        <div class="suggestion" onclick="askSuggestion(this)"><span>Care Recommendations</span>Suggest next steps in treatment</div>
                    </div>
                </div>`;
        }

        function askSuggestion(el) {
            document.getElementById('userInput').value = el.textContent.trim();
            send();
        }

        // ── Sidebar list ──
        function renderList() {
            const el = document.getElementById('chatList');
            if (!chats.length) {
                el.innerHTML = '<div style="padding:16px;text-align:center;font-size:11px;color:var(--ms-text-tertiary)">No chats yet</div>';
                return;
            }
            el.innerHTML = chats.map(c => {
                const lastMsg = c.messages.length ? c.messages[c.messages.length - 1].content.substring(0, 40) + '...' : 'No messages';
                const count = c.messages.filter(m => m.role === 'user').length;
                return `<div class="chat-item ${c.id === activeChatId ? 'active' : ''}" onclick="loadChat('${c.id}')">
                    <div class="chat-item-name">${esc(c.name)}</div>
                    <div class="chat-item-meta">
                        <span class="chat-item-pid">PID ${c.pid}</span>
                        <span>${count} message${count !== 1 ? 's' : ''}</span>
                    </div>
                </div>`;
            }).join('');
        }

        // ── Load Chat ──
        function loadChat(id) {
            const chat = chats.find(c => c.id === id);
            if (!chat) return;
            activeChatId = id;
            const container = document.getElementById('messages');
            if (!chat.messages.length) {
                showWelcome();
            } else {
                container.innerHTML = chat.messages.map(m => msgHTML(m.role, m.content, m.images)).join('');
                container.scrollTop = container.scrollHeight;
            }
            renderList();
        }

        function msgHTML(role, content, images) {
            const isUser = role === 'user';
            const rendered = isUser ? esc(content).replace(/\n/g, '<br>') : renderMD(content);
            let imgHTML = '';
            if (images && images.length) {
                imgHTML = '<div class="msg-images">' + images.map(src => `<img src="${src}" onclick="window.open(this.src)">`).join('') + '</div>';
            }
            return `<div class="msg-row ${role}">
                <div class="msg-avatar ${isUser ? 'user-av' : 'ai-av'}">${isUser ? '' : '<i class="fa fa-stethoscope"></i>'}</div>
                <div class="msg-bubble">
                    ${imgHTML}
                    <div class="msg-text">${rendered}</div>
                </div>
            </div>`;
        }

        // ── Attachments ──
        let pendingImages = [];

        function handleFiles(input) {
            const files = Array.from(input.files);
            files.forEach(file => {
                if (!file.type.startsWith('image/')) return;
                const reader = new FileReader();
                reader.onload = (e) => {
                    pendingImages.push(e.target.result);
                    renderPreviews();
                };
                reader.readAsDataURL(file);
            });
            input.value = '';
        }

        function renderPreviews() {
            const el = document.getElementById('attachPreview');
            el.innerHTML = pendingImages.map((src, i) => `
                <div class="attach-thumb">
                    <img src="${src}">
                    <button class="attach-thumb-remove" onclick="removeAttach(${i})">&times;</button>
                </div>
            `).join('');
        }

        function removeAttach(i) {
            pendingImages.splice(i, 1);
            renderPreviews();
        }

        // ── Input Handling (contenteditable) ──
        const inputEl = document.getElementById('userInput');
        if (inputEl) {
            inputEl.addEventListener('input', function() {
                // Handle empty state attribute for placeholder
                const text = this.innerText.replace(/[\n\r]+$/, '').trim();
                this.setAttribute('empty', text.length === 0 ? 'true' : 'false');
            });

            inputEl.addEventListener('paste', function(e) {
                // Strip formatting when pasting
                e.preventDefault();
                const text = (e.originalEvent || e).clipboardData.getData('text/plain');
                document.execCommand('insertText', false, text);
            });

            inputEl.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) { 
                    e.preventDefault(); 
                    send(); 
                }
            });
        }

        // ── Send ──
        async function send() {
            if (PID <= 0) return;
            const input = document.getElementById('userInput');
            const text = input.innerText.trim();
            if ((!text && !pendingImages.length) || busy) return;

            // Ensure chat/session exists for this patient
            let chat = chats.find(c => c.pid == PID);
            if (!chat) {
                try {
                    const res = await fetch(`${AGENT_PROXY}?action=proxy_session`, { 
                        method: 'POST',
                        credentials: 'same-origin'
                    });
                    const data = await res.json();
                    chat = { id: data.session_id, pid: PID, name: PNAME, messages: [], created: new Date().toISOString() };
                    chats.unshift(chat);
                } catch(e) {
                    chat = { id: 'local_' + Date.now(), pid: PID, name: PNAME, messages: [], created: new Date().toISOString() };
                    chats.unshift(chat);
                }
            }
            activeChatId = chat.id;

            const w = document.getElementById('welcome');
            if (w) w.remove();
            const np = document.getElementById('noPatient');
            if (np) np.remove();

            const images = [...pendingImages];
            pendingImages = [];
            renderPreviews();

            const msgObj = { role: 'user', content: text || '(image attached)' };
            if (images.length) msgObj.images = images;
            chat.messages.push(msgObj);
            appendMsg('user', msgObj.content, images);
            
            input.innerHTML = '';
            input.setAttribute('empty', 'true');
            busy = true;
            document.getElementById('sendBtn').disabled = true;
            save();
            renderList();

            const thinkId = appendThinking();

            try {
                // Build patient context header for reliable patient identification
                const pm = PATIENT_META;
                const patientContext = [
                    `[PATIENT CONTEXT]`,
                    `Name: ${pm.name || PNAME}`,
                    pm.dob    ? `DOB: ${pm.dob}`       : null,
                    pm.sex    ? `Sex: ${pm.sex}`        : null,
                    pm.phone  ? `Phone: ${pm.phone}`    : null,
                    `OpenEMR PID: ${pm.pid || PID}`,
                    pm.pubpid ? `Public ID: ${pm.pubpid}` : null,
                    pm.uuid   ? `OpenEMR UUID: ${pm.uuid}` : null,
                    (pm.city || pm.state) ? `Location: ${[pm.city, pm.state].filter(Boolean).join(', ')}` : null,
                    `[END PATIENT CONTEXT]`,
                    '',
                    text
                ].filter(x => x !== null).join('\n');

                // DoctorChatRequest — OpenEMR doctor endpoint
                const payload = {
                    message: patientContext,
                    patient_id: (pm.pid || PID).toString()
                };

                const res = await fetch(`${AGENT_PROXY}?action=proxy_chat&session_id=${activeChatId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify(payload)
                });
                
                removeEl(thinkId);
                
                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: 'Agent API unavailable' }));
                    const msg = err.error || 'Request failed.';
                    chat.messages.push({ role: 'assistant', content: msg });
                    appendMsg('assistant', msg);
                } else {
                    const data = await res.json();
                    
                    // Parse orchestrator response
                    // Extract content, sources, and clean up <answer> tags
                    let replyText = data.content || 'No response.';
                    replyText = replyText.replace(/<\/?answer>/g, '');
                    
                    if (data.sources && data.sources.length) {
                        const sourceLinks = data.sources.map(s => `- [${new URL(s).hostname}](${s})`).join('\\n');
                        replyText += '\\n\\n**Sources:**\\n' + sourceLinks;
                    }
                    
                    chat.messages.push({ role: 'assistant', content: replyText });
                    appendMsg('assistant', replyText);
                }
            } catch (e) {
                removeEl(thinkId);
                const msg = 'Cannot connect to AI Agent endpoint. Check Cloud Run service status.';
                chat.messages.push({ role: 'assistant', content: msg });
                appendMsg('assistant', msg);
            }

            busy = false;
            document.getElementById('sendBtn').disabled = false;
            save();
            input.focus();
        }

        function appendMsg(role, content, images) {
            const c = document.getElementById('messages');
            const d = document.createElement('div');
            d.innerHTML = msgHTML(role, content, images);
            c.appendChild(d.firstElementChild);
            c.scrollTop = c.scrollHeight;
        }

        function appendThinking() {
            const id = 't_' + Date.now();
            const c = document.getElementById('messages');
            const d = document.createElement('div');
            d.innerHTML = `<div class="msg-row assistant" id="${id}">
                <div class="msg-avatar ai-av"><i class="fa fa-stethoscope" style="font-size:11px"></i></div>
                <div class="msg-bubble">
                    <div class="msg-text" style="padding:10px 0"><div class="thinking"><span></span><span></span><span></span></div></div>
                </div>
            </div>`;
            c.appendChild(d.firstElementChild);
            c.scrollTop = c.scrollHeight;
            return id;
        }

        function removeEl(id) { const e = document.getElementById(id); if (e) e.remove(); }
        function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
        function renderMD(t) { if (typeof marked !== 'undefined') { marked.setOptions({ breaks: true }); return marked.parse(t); } return esc(t).replace(/\n/g, '<br>'); }

        init();
    </script>
</body>
</html>
