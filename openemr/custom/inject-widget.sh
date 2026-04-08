#!/bin/sh
# Inject Med-SEAL AI Chat Widget into OpenEMR's header
# This script is run after OpenEMR starts to add the AI widget
# to the main header include file.

HEADER_FILE="/var/www/localhost/htdocs/openemr/interface/header.inc.php"
MARKER="<!-- MEDSEAL-AI-WIDGET -->"

if [ -f "$HEADER_FILE" ]; then
    # Check if already injected
    if grep -q "$MARKER" "$HEADER_FILE"; then
        echo "[MedSEAL] AI widget already injected."
    else
        echo "[MedSEAL] Injecting AI chat widget into OpenEMR..."
        # Append before closing of the header file
        cat >> "$HEADER_FILE" << 'EOF'

<!-- MEDSEAL-AI-WIDGET -->
<link rel="stylesheet" href="/openemr/public/assets/ai-chat-widget.css">
<script src="/openemr/public/assets/ai-chat-widget.js" defer></script>
EOF
        echo "[MedSEAL] AI widget injected successfully!"
    fi
else
    echo "[MedSEAL] Warning: header.inc.php not found at $HEADER_FILE"
    # Try alternate path
    ALT_HEADER="/var/www/localhost/htdocs/openemr/src/Core/Header.php"
    if [ -f "$ALT_HEADER" ]; then
        echo "[MedSEAL] Found Header.php at $ALT_HEADER"
    fi
fi
