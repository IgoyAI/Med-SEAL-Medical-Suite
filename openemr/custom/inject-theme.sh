#!/bin/sh
# ═══════════════════════════════════════════════════════
# Inject Med-SEAL SSO Theme into OpenEMR (theme only)
# ═══════════════════════════════════════════════════════
# Run after container restart:
#   docker exec medseal-openemr sh /opt/medseal/inject-theme.sh

HEADER="/var/www/localhost/htdocs/openemr/src/Core/Header.php"
ASSETS_DIR="/var/www/localhost/htdocs/openemr/public/assets"
MARKER="MEDSEAL-THEME-INJECTED"

echo "[MedSEAL] Copying theme CSS to public directory..."
mkdir -p "$ASSETS_DIR"
cp /opt/medseal/medseal-theme.css "$ASSETS_DIR/medseal-theme.css"
echo "[MedSEAL] Theme CSS copied."

if [ ! -f "$HEADER" ]; then
    echo "[MedSEAL] ERROR: Header.php not found at $HEADER"
    exit 1
fi

if grep -q "$MARKER" "$HEADER"; then
    echo "[MedSEAL] Already injected into Header.php — skipping."
else
    echo "[MedSEAL] Patching Header.php setupHeader() method..."
    sed -i '/Module Styles Ended/,/if (\$echoOutput)/{
      /if (\$echoOutput)/i\
        // MEDSEAL-THEME-INJECTED\
        $output .= "<link rel=\\"stylesheet\\" href=\\"/public/assets/medseal-theme.css\\" />\\n";\

    }' "$HEADER"
    echo "[MedSEAL] Injected successfully!"
fi

echo "[MedSEAL] Done. Hard-refresh OpenEMR (Cmd+Shift+R) to see changes."
