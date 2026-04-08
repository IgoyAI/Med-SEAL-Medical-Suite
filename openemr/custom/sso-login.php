<?php
/**
 * Med-SEAL SSO Auto-Login for OpenEMR
 * 
 * This script receives credentials via POST and auto-submits
 * the OpenEMR login form, bypassing the login page.
 */

// Get credentials from POST or query string
$user = $_POST['user'] ?? $_GET['user'] ?? '';
$pass = $_POST['pass'] ?? $_GET['pass'] ?? '';
$site = 'default';

if (empty($user) || empty($pass)) {
    // No credentials, redirect to normal login
    header('Location: /interface/login/login.php?site=' . $site);
    exit;
}
?>
<!DOCTYPE html>
<html>
<head>
    <title>Signing in...</title>
    <style>
        body {
            font-family: -apple-system, system-ui, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            background: #f8f9fa;
            color: #6b7280;
        }
        .loader { text-align: center; }
        .spinner {
            width: 32px; height: 32px;
            border: 3px solid #e5e7eb;
            border-top: 3px solid #0066cc;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin: 0 auto 12px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="loader">
        <div class="spinner"></div>
        Signing in to OpenEMR...
    </div>
    <form id="loginForm" method="POST" action="/interface/main/main_screen.php?auth=login&site=<?php echo htmlspecialchars($site); ?>">
        <input type="hidden" name="new_login_session_management" value="1">
        <input type="hidden" name="authUser" value="<?php echo htmlspecialchars($user); ?>">
        <input type="hidden" name="clearPass" value="<?php echo htmlspecialchars($pass); ?>">
        <input type="hidden" name="languageChoice" value="1">
    </form>
    <script>
        document.getElementById('loginForm').submit();
    </script>
</body>
</html>
