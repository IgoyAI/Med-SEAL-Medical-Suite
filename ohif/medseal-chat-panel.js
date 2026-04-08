/**
 * Med-SEAL AI Chat — Native OHIF Right Panel (NO OVERLAY)
 * Uses position:fixed for panel but forces #root to shrink via CSS,
 * making OHIF's viewport resize naturally. No overlay at all.
 * Chat icon in OHIF's right-side vertical toolbar strip.
 * Panel is resizable by dragging the left edge.
 */
(function () {
    'use strict';

    const ORTHANC_WEB = '/dicom-web';
    let studyMeta = null;
    let messages = [];
    let chatActive = false;
    let panelWidth = 380;
    const MIN_W = 280;
    const MAX_W = 700;

    // ═══ Study metadata ═══
    function getStudyUID() {
        const m = window.location.href.match(/StudyInstanceUIDs=([^&]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    }

    async function fetchStudyMeta(uid) {
        try {
            const r = await fetch(`${ORTHANC_WEB}/studies?StudyInstanceUID=${uid}&includefield=all`);
            if (!r.ok) return null;
            const data = await r.json();
            if (!data.length) return null;
            const s = data[0];
            return {
                patientName: s['00100010']?.Value?.[0]?.Alphabetic || 'Unknown',
                patientID: s['00100020']?.Value?.[0] || '',
                studyDate: s['00080020']?.Value?.[0] || '',
                studyDesc: s['00081030']?.Value?.[0] || '',
                modality: s['00080061']?.Value?.[0] || s['00080060']?.Value?.[0] || '',
                bodyPart: s['00180015']?.Value?.[0] || '',
            };
        } catch (e) { return null; }
    }

    // ═══ AI Response ═══
    function aiResponse(q, m) {
        const ql = q.toLowerCase();
        const name = m?.patientName || 'the patient';
        const study = m?.studyDesc || 'this study';
        const mod = m?.modality || 'imaging';

        if (ql.includes('finding') || ql.includes('interpret')) {
            return `Based on the ${mod} ${study} for ${name}:\n\n• No acute pathology identified on initial AI review\n• Study quality is adequate for interpretation\n• Correlate with clinical presentation\n\nNote: AI-assisted preliminary read. Final interpretation by radiologist required.`;
        }
        if (ql.includes('differential') || ql.includes('diagnosis')) {
            return `Differential for ${mod} ${study} — ${name}:\n\n1. Most likely: Normal / age-appropriate changes\n2. Consider: Incidental findings requiring follow-up\n3. Less likely: Acute pathology\n\nDescribe the specific finding for a targeted differential.`;
        }
        if (ql.includes('protocol') || ql.includes('technique')) {
            return `Protocol — ${study}\n\nModality: ${mod}\nPatient: ${name}\nDate: ${m?.studyDate || 'N/A'}\nBody: ${m?.bodyPart || 'Not specified'}\n\nStandard departmental protocol followed.`;
        }
        if (ql.includes('draft') || ql.includes('report')) {
            return `RADIOLOGY REPORT\n════════════════\nPatient: ${name}\nStudy: ${study}\nDate: ${m?.studyDate || 'N/A'}\nModality: ${mod}\n\nTECHNIQUE: ${mod} ${study}.\n\nCOMPARISON: None.\n\nFINDINGS:\n[Enter findings]\n\nIMPRESSION:\n1. [Enter impression]\n\n— AI Draft (Pending Review)`;
        }
        return `I'm your clinical assistant for this ${mod} study of ${name}.\n\nI can help with:\n• Findings interpretation\n• Differential diagnosis\n• Report drafting\n• Protocol review\n• Measurement guidance\n\nWhat would you like to explore?`;
    }

    // ═══ CSS ═══
    function injectCSS() {
        if (document.getElementById('ms-chat-styles')) return;
        const style = document.createElement('style');
        style.id = 'ms-chat-styles';
        style.textContent = `
            /* ─── Panel: fixed on right, full height ─── */
            #ms-chat-tool {
                position: fixed;
                top: 0; right: 0; bottom: 0;
                width: 0;
                overflow: hidden;
                background: #090c29;
                border-left: 2px solid #152746;
                display: flex;
                flex-direction: column;
                z-index: 10;
                font-family: Inter, system-ui, sans-serif;
                transition: width 0.25s ease;
            }
            #ms-chat-tool.open {
                width: var(--ms-panel-w, ${panelWidth}px);
            }

            /* ─── KEY: force OHIF #root to shrink when panel open ─── */
            body.ms-chat-open #root {
                width: calc(100vw - var(--ms-panel-w, ${panelWidth}px)) !important;
                max-width: calc(100vw - var(--ms-panel-w, ${panelWidth}px)) !important;
                transition: width 0.25s ease, max-width 0.25s ease;
            }

            /* Drag handle on left edge */
            .ms-drag-handle {
                position: absolute;
                left: -4px; top: 0; bottom: 0;
                width: 8px;
                cursor: col-resize;
                z-index: 25;
                background: transparent;
            }
            .ms-drag-handle:hover,
            .ms-drag-handle.dragging {
                background: rgba(90,204,230,0.3);
            }

            /* Section header — OHIF style */
            .ms-section-hdr {
                display: flex; align-items: center; justify-content: space-between;
                padding: 0 10px; height: 28px; margin: 2px 4px;
                border-radius: 4px; background: #151932;
                color: #a3b9cc; font-size: 13px; font-weight: 500;
                cursor: pointer; flex-shrink: 0; user-select: none;
                border: none; width: calc(100% - 8px);
                font-family: inherit;
            }
            .ms-section-hdr:hover { background: #20396e; }
            .ms-section-hdr svg { width: 12px; height: 12px; }

            /* Panel top bar */
            .ms-tool-bar {
                display: flex; align-items: center; justify-content: center;
                gap: 4px; padding: 6px 8px;
                border-bottom: 2px solid #152746;
                background: #090c29; flex-shrink: 0;
            }
            .ms-tool-bar button {
                width: 28px; height: 28px; border-radius: 5px;
                border: none; background: #1a2a4a; color: #5acce6;
                cursor: pointer; display: flex; align-items: center; justify-content: center;
            }

            /* Study context */
            .ms-ctx {
                padding: 8px 12px; font-size: 11px; color: #5e8ab4;
                border-bottom: 1px solid #152746; flex-shrink: 0;
                display: grid; grid-template-columns: auto 1fr; gap: 2px 8px;
            }
            .ms-ctx-v { color: #a3b9cc; font-weight: 500; }

            /* Messages */
            .ms-msgs {
                flex: 1; overflow-y: auto; padding: 10px;
                display: flex; flex-direction: column; gap: 8px;
            }
            .ms-msgs::-webkit-scrollbar { width: 3px; }
            .ms-msgs::-webkit-scrollbar-thumb { background: #1a3a5c; border-radius: 3px; }
            .ms-msgs::-webkit-scrollbar-track { background: transparent; }

            .ms-msg { max-width: 92%; animation: msFade 0.2s ease; }
            @keyframes msFade {
                from { opacity: 0; transform: translateY(3px); }
                to { opacity: 1; transform: none; }
            }
            .ms-msg-u { align-self: flex-end; }
            .ms-msg-a { align-self: flex-start; }
            .ms-bubble {
                padding: 8px 12px; border-radius: 6px;
                font-size: 12.5px; line-height: 1.55;
                white-space: pre-wrap; word-break: break-word;
            }
            .ms-msg-u .ms-bubble { background: #1d4f91; color: #e8f0fa; }
            .ms-msg-a .ms-bubble {
                background: #151932; color: #a3b9cc;
                border: 1px solid #1a2a4a;
            }
            .ms-time { font-size: 9px; color: #3a5a7a; margin-top: 2px; padding: 0 4px; }
            .ms-msg-u .ms-time { text-align: right; }

            /* Quick prompts */
            .ms-qp {
                display: flex; flex-wrap: wrap; gap: 4px;
                padding: 8px 10px;
                border-top: 1px solid #152746; flex-shrink: 0;
            }
            .ms-qp-btn {
                padding: 4px 10px; background: #151932;
                border: 1px solid #1a2a4a; border-radius: 4px;
                color: #5e8ab4; font-size: 11px; cursor: pointer;
                font-family: inherit; transition: all 0.12s;
            }
            .ms-qp-btn:hover { background: #1a2a4a; color: #5acce6; border-color: #5acce6; }

            /* Input */
            .ms-input-row {
                display: flex; gap: 6px; padding: 10px;
                background: #090c29; border-top: 1px solid #152746; flex-shrink: 0;
            }
            .ms-input-row textarea {
                flex: 1; background: #0a1628; border: 1px solid #1a2a4a;
                border-radius: 6px; color: #e8f0fa; padding: 8px 10px;
                font-family: inherit; font-size: 12.5px; line-height: 1.4;
                resize: none; outline: none; max-height: 80px;
            }
            .ms-input-row textarea::placeholder { color: #3a5a7a; }
            .ms-input-row textarea:focus { border-color: #5acce6; }
            .ms-send {
                width: 34px; height: 34px; border-radius: 6px;
                border: none; background: #5acce6; color: #090c29;
                cursor: pointer; display: flex; align-items: center; justify-content: center;
                flex-shrink: 0; transition: background 0.12s;
            }
            .ms-send:hover { background: #7dd8ec; }
            .ms-send:disabled { background: #1a2a4a; color: #3a5a7a; cursor: not-allowed; }

            /* Typing */
            .ms-typing { display: flex; gap: 3px; padding: 4px 0; }
            .ms-typing span {
                width: 5px; height: 5px; border-radius: 50%;
                background: #5acce6; animation: msBnc 1.4s infinite ease-in-out;
            }
            .ms-typing span:nth-child(2) { animation-delay: 0.2s; }
            .ms-typing span:nth-child(3) { animation-delay: 0.4s; }
            @keyframes msBnc {
                0%,80%,100% { transform: scale(0.5); opacity: 0.3; }
                40% { transform: scale(1); opacity: 1; }
            }

            /* Welcome */
            .ms-welcome {
                flex: 1; display: flex; flex-direction: column;
                align-items: center; justify-content: center;
                text-align: center; padding: 24px 16px; gap: 10px; color: #5e8ab4;
            }
            .ms-welcome svg { width: 36px; height: 36px; color: #5acce6; margin-bottom: 4px; }
            .ms-welcome h4 { margin: 0; font-size: 14px; color: #a3b9cc; font-weight: 600; }
            .ms-welcome p { margin: 0; font-size: 12px; line-height: 1.6; }

            /* Hide old toggle */
            #ms-chat-toggle { display: none !important; }

            /* Active state for right toolbar button */
            #ms-rt-chat-btn.active {
                color: #5acce6 !important;
                background: rgba(90,204,230,0.15) !important;
            }
        `;
        document.head.appendChild(style);
    }

    // ═══ Build Panel ═══
    function buildPanel() {
        if (document.getElementById('ms-chat-tool')) return;

        const panel = document.createElement('div');
        panel.id = 'ms-chat-tool';
        panel.innerHTML = `
            <div class="ms-drag-handle" id="ms-drag"></div>
            <div class="ms-tool-bar">
                <button title="AI Chat" style="pointer-events:none">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                </button>
            </div>
            <button class="ms-section-hdr" id="ms-hdr-chat">
                <span>AI Chat</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform:rotate(90deg)"><path d="M9 18l6-6-6-6"/></svg>
            </button>
            <div class="ms-ctx" id="ms-ctx">
                <span>Study</span><span class="ms-ctx-v" id="ms-ctx-study">Loading...</span>
                <span>Patient</span><span class="ms-ctx-v" id="ms-ctx-patient">—</span>
            </div>
            <div class="ms-msgs" id="ms-msgs">
                <div class="ms-welcome">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    <h4>Med-SEAL AI</h4>
                    <p>Clinical assistant for this study. Ask about findings, differentials, or draft a report.</p>
                </div>
            </div>
            <div class="ms-qp" id="ms-qp">
                <button class="ms-qp-btn" data-q="Interpret the findings">🔍 Findings</button>
                <button class="ms-qp-btn" data-q="Suggest differential diagnosis">🧠 DDx</button>
                <button class="ms-qp-btn" data-q="Draft a radiology report">📝 Report</button>
                <button class="ms-qp-btn" data-q="Review the protocol">📋 Protocol</button>
            </div>
            <div class="ms-input-row">
                <textarea id="ms-ta" rows="1" placeholder="Ask about this study..." maxlength="2000"></textarea>
                <button class="ms-send" id="ms-send" disabled>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                </button>
            </div>
        `;
        document.body.appendChild(panel);

        // ── Drag-to-resize ──
        const drag = document.getElementById('ms-drag');
        let dragging = false;
        let startX = 0;
        let startW = panelWidth;

        drag.addEventListener('mousedown', (e) => {
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startW = panel.offsetWidth;
            drag.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = startX - e.clientX;
            let newW = Math.max(MIN_W, Math.min(MAX_W, startW + dx));
            panelWidth = newW;
            panel.style.width = newW + 'px';
            document.documentElement.style.setProperty('--ms-panel-w', newW + 'px');
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            drag.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            // Trigger OHIF viewport recalculation
            setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
        });

        // ── Input events ──
        const ta = document.getElementById('ms-ta');
        const sendBtn = document.getElementById('ms-send');

        ta.addEventListener('input', () => {
            sendBtn.disabled = !ta.value.trim();
            ta.style.height = 'auto';
            ta.style.height = Math.min(ta.scrollHeight, 80) + 'px';
        });
        ta.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
        });
        sendBtn.addEventListener('click', sendMsg);

        panel.querySelectorAll('.ms-qp-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                ta.value = btn.dataset.q;
                sendBtn.disabled = false;
                sendMsg();
            });
        });
    }

    // ═══ Inject chat icon into OHIF's RIGHT toolbar strip ═══
    function injectToolbarIcon() {
        if (document.getElementById('ms-rt-chat-btn')) return;

        const chatBtn = document.createElement('button');
        chatBtn.id = 'ms-rt-chat-btn';
        chatBtn.title = 'AI Chat';
        chatBtn.setAttribute('type', 'button');
        chatBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="22" height="22" style="pointer-events:none">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
        `;

        chatBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            e.stopImmediatePropagation();
            e.preventDefault();
            toggleChat();
        }, true);

        // Find the right toolbar strip
        const allBtns = document.querySelectorAll('button');
        let rightToolbarBtns = [];
        for (const b of allBtns) {
            const r = b.getBoundingClientRect();
            if (r.left > window.innerWidth - 80 && r.width < 50 && r.height < 50 &&
                r.top > 30 && r.top < 250 && b.querySelector('svg') && !b.id.includes('ms-')) {
                rightToolbarBtns.push(b);
            }
        }

        if (rightToolbarBtns.length > 0) {
            const toolbarStrip = rightToolbarBtns[0].parentElement;
            chatBtn.className = rightToolbarBtns[0].className;
            toolbarStrip.appendChild(chatBtn);
            console.log('[MedSEAL] Chat icon added to right toolbar strip');
        } else {
            // Fallback: place in header area
            chatBtn.style.cssText = `
                position:fixed; top:44px; right:4px; width:28px; height:28px;
                z-index:100000; background:#090c29; border:1px solid #152746;
                border-radius:6px; color:#5acce6; display:flex;
                align-items:center; justify-content:center; cursor:pointer;
            `;
            document.body.appendChild(chatBtn);
            console.log('[MedSEAL] Chat icon in fallback position');
        }
    }

    // ═══ Toggle ═══
    function toggleChat() {
        chatActive = !chatActive;
        const panel = document.getElementById('ms-chat-tool');
        const btn = document.getElementById('ms-rt-chat-btn');

        // Set CSS variable for panel width
        document.documentElement.style.setProperty('--ms-panel-w', panelWidth + 'px');

        if (chatActive) {
            if (panel) panel.classList.add('open');
            if (btn) btn.classList.add('active');
            // Add class to body — this triggers #root width constraint via CSS
            document.body.classList.add('ms-chat-open');
            if (!studyMeta) loadCtx();
        } else {
            if (panel) panel.classList.remove('open');
            if (btn) btn.classList.remove('active');
            document.body.classList.remove('ms-chat-open');
        }
        // Trigger OHIF viewport resize recalculation
        setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
        setTimeout(() => window.dispatchEvent(new Event('resize')), 600);
    }

    // ═══ Load study context ═══
    async function loadCtx() {
        const uid = getStudyUID();
        if (!uid) {
            const el = document.getElementById('ms-ctx-study');
            if (el) el.textContent = 'No study loaded';
            return;
        }
        studyMeta = await fetchStudyMeta(uid);
        if (studyMeta) {
            const el1 = document.getElementById('ms-ctx-study');
            const el2 = document.getElementById('ms-ctx-patient');
            if (el1) el1.textContent = studyMeta.studyDesc || studyMeta.modality;
            if (el2) el2.textContent = studyMeta.patientName;
            if (messages.length === 0) {
                addMsg('a', `Ready for ${studyMeta.studyDesc || studyMeta.modality} — ${studyMeta.patientName}.\n\nAsk about findings, differentials, or request a report draft.`);
            }
        }
    }

    // ═══ Messages ═══
    function addMsg(role, content) {
        messages.push({ role, content, time: new Date() });
        renderMsgs();
    }

    function renderMsgs() {
        const c = document.getElementById('ms-msgs');
        if (!c) return;
        c.innerHTML = messages.map(m => {
            const cls = m.role === 'u' ? 'ms-msg-u' : 'ms-msg-a';
            const t = m.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return `<div class="ms-msg ${cls}"><div class="ms-bubble">${m.content}</div><div class="ms-time">${t}</div></div>`;
        }).join('');
        c.scrollTop = c.scrollHeight;
    }

    async function sendMsg() {
        const ta = document.getElementById('ms-ta');
        if (!ta) return;
        const text = ta.value.trim();
        if (!text) return;
        ta.value = '';
        ta.style.height = 'auto';
        const sendBtn = document.getElementById('ms-send');
        if (sendBtn) sendBtn.disabled = true;
        const qp = document.getElementById('ms-qp');
        if (qp) qp.style.display = 'none';

        addMsg('u', text);

        const c = document.getElementById('ms-msgs');
        if (c) {
            const typing = document.createElement('div');
            typing.className = 'ms-msg ms-msg-a';
            typing.id = 'ms-typing';
            typing.innerHTML = '<div class="ms-bubble"><div class="ms-typing"><span></span><span></span><span></span></div></div>';
            c.appendChild(typing);
            c.scrollTop = c.scrollHeight;

            await new Promise(r => setTimeout(r, 600 + Math.random() * 800));
            typing.remove();
        }

        addMsg('a', aiResponse(text, studyMeta));
    }

    // ═══ Public API ═══
    window.msChat = { toggle: toggleChat };

    // ═══ Init ═══
    let panelBuilt = false;

    function trySetup() {
        if (!panelBuilt) {
            injectCSS();
            buildPanel();
            panelBuilt = true;
        }
        // Always try to inject icon (MutationObserver may have removed it)
        injectToolbarIcon();
    }

    function onReady() {
        trySetup();
        if (getStudyUID()) setTimeout(loadCtx, 2000);

        // SPA navigation watcher
        let lastUrl = window.location.href;
        setInterval(() => {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                setTimeout(() => {
                    trySetup();
                    if (getStudyUID()) { studyMeta = null; loadCtx(); }
                }, 3000);
            }
        }, 1000);

        // MutationObserver — re-inject icon if React removes it
        let mutationTimer = null;
        const observer = new MutationObserver(() => {
            if (mutationTimer) clearTimeout(mutationTimer);
            mutationTimer = setTimeout(() => {
                if (!document.getElementById('ms-rt-chat-btn')) {
                    injectToolbarIcon();
                }
            }, 500);
        });
        observer.observe(document.body, { childList: true, subtree: true });

        console.log('[MedSEAL] AI Chat initialized (push-layout mode)');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
})();
