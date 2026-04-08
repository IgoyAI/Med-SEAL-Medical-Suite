// Med-SEAL AI Chat Navbar Button
// Injects an "AI Chat" button into the OpenEMR top navbar
document.addEventListener('DOMContentLoaded', function() {
    if (window !== window.top) return; // only in top frame
    setTimeout(function() {
        var nav = document.querySelector('.navbar-nav.appMenu');
        if (!nav) return;
        var wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.marginLeft = '8px';
        var btn = document.createElement('a');
        btn.className = 'menuLabel';
        btn.style.cssText = 'color:#fff;cursor:pointer;display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:6px;font-weight:600;background:rgba(255,255,255,0.12);white-space:nowrap';
        btn.innerHTML = '\uD83E\uDD16 AI Chat';
        btn.onclick = function() {
            if (typeof top.restoreSession === 'function') top.restoreSession();
            if (top.RTop) {
                top.RTop.location = '/interface/main/medseal_chat.php';
            } else {
                window.open('/interface/main/medseal_chat.php', '_blank');
            }
        };
        wrapper.appendChild(btn);
        nav.appendChild(wrapper);
    }, 1500);
});
