/**
 * Med-SEAL AI Agent Sidebar
 * EMBEDDED into OpenEMR's main layout (not a floating widget).
 * Injected as a flex sibling inside #mainFrames_div.
 * 5 agents with independent chat histories.
 */
(function () {
    'use strict';

    const AI_URL = window.MEDSEAL_AI_URL || 'https://medseal-agent-74997794842.asia-southeast1.run.app';

    // ═══ Agent Definitions ═══
    const AGENTS = [
        {
            id: 'clinical',
            name: 'Clinical Copilot',
            icon: '🩺',
            desc: 'SOAP notes, assessments, plans, prescriptions',
            endpoint: '/chat',
            actions: [
                { key: 'soap', label: '📋 SOAP', prompt: 'Draft a SOAP note for {patient}\'s visit today.\nSUBJECTIVE:\nOBJECTIVE:\nASSESSMENT:\nPLAN:' },
                { key: 'assessment', label: '🩺 Assessment', prompt: 'Draft a clinical assessment for {patient}. Include differential diagnoses ranked by likelihood, key findings, and recommended workup.' },
                { key: 'plan', label: '📝 Plan', prompt: 'Draft a treatment plan for {patient}. Include medications with dosages, follow-up schedule, patient education, and referrals.' },
                { key: 'hpi', label: '📄 HPI', prompt: 'Draft the History of Present Illness (HPI) for {patient}.' },
                { key: 'rx', label: '💊 Rx', prompt: 'Draft a prescription for {patient}.\nMedication:\nDose:\nRoute:\nFrequency:\nDuration:\nRefills:\nInstructions:' },
                { key: 'referral', label: '📨 Referral', prompt: 'Draft a referral letter for {patient}.' },
            ],
            welcome: '👋 I\'m your **Clinical Copilot**. I draft notes, assessments, plans, and prescriptions. I fill the form — **you review and save**.\n\nOpen a patient chart and click a quick action.',
        },
        {
            id: 'radiology',
            name: 'Radiology AI',
            icon: '📡',
            desc: 'Interpret imaging, draft radiology reports',
            endpoint: '/radiology',
            actions: [
                { key: 'interpret', label: '🔍 Interpret', prompt: 'Interpret the latest imaging study for {patient}.' },
                { key: 'report', label: '📝 Report', prompt: 'Draft a formal radiology report for {patient}.\nCLINICAL INDICATION:\nTECHNIQUE:\nFINDINGS:\nIMPRESSION:' },
                { key: 'compare', label: '📊 Compare', prompt: 'Compare {patient}\'s current imaging with prior studies.' },
                { key: 'critical', label: '🚨 Critical', prompt: 'Draft a critical finding notification for {patient}.' },
            ],
            welcome: '📡 **Radiology AI** ready. I interpret imaging, draft reports, compare with priors, and flag critical findings.\n\nSelect a patient with imaging studies.',
        },
        {
            id: 'cds',
            name: 'CDS Engine',
            icon: '🧠',
            desc: 'Decision support, drug interactions, alerts',
            endpoint: '/cds',
            actions: [
                { key: 'interactions', label: '💊 Drug Check', prompt: 'Check drug-drug interactions in {patient}\'s medication list.' },
                { key: 'guidelines', label: '📋 Guidelines', prompt: 'What clinical practice guidelines apply to {patient}?' },
                { key: 'screening', label: '🔬 Screenings', prompt: 'What preventive screenings are due for {patient}?' },
                { key: 'risk', label: '⚠️ Risk Score', prompt: 'Calculate relevant clinical risk scores for {patient}.' },
            ],
            welcome: '🧠 **CDS Engine** active. I analyze medications, check guidelines, and calculate risk scores.\n\nSelect a patient for personalized alerts.',
        },
        {
            id: 'ambient',
            name: 'Ambient Scribe',
            icon: '🎙️',
            desc: 'Auto-document from encounters',
            endpoint: '/ambient',
            actions: [
                { key: 'summarize', label: '📝 Summarize', prompt: 'Summarize the clinical encounter for {patient}.' },
                { key: 'aftervisit', label: '📄 AVS', prompt: 'Draft an After Visit Summary for {patient} in patient-friendly language.' },
                { key: 'discharge', label: '🏥 Discharge', prompt: 'Draft discharge instructions for {patient}.' },
            ],
            welcome: '🎙️ **Ambient Scribe** ready. I convert clinical encounters into structured documentation.\n\nDescribe the visit to generate notes.',
        },
        {
            id: 'analytics',
            name: 'Analytics',
            icon: '📊',
            desc: 'Patient trends, timelines, population health',
            endpoint: '/chat',
            actions: [
                { key: 'trends', label: '📈 Trends', prompt: 'Analyze lab and vital trends for {patient} over the past year.' },
                { key: 'timeline', label: '🕐 Timeline', prompt: 'Create a clinical timeline for {patient}.' },
                { key: 'cohort', label: '👥 Cohort', prompt: 'Compare {patient}\'s outcomes with similar cohorts.' },
            ],
            welcome: '📊 **Health Analytics** ready. I analyze trends, create timelines, and compare outcomes.\n\nSelect a patient to analyze.',
        },
    ];

    // ═══ State ═══
    let activeAgent = null;
    let isExpanded = false;
    let isLoading = false;
    let currentPatient = null;
    let patientPollInterval = null;

    const agentState = {};
    AGENTS.forEach(function (a) {
        agentState[a.id] = { chatHistory: [], savedHTML: null, hasNotif: false, sessionId: null };
    });

    // ═══ Build DOM — injected into #mainFrames_div ═══
    function createSidebar() {
        // Guard: only run once - check if sidebar already exists anywhere
        try {
            var existing = (window.top || window.parent || window).document.getElementById('medseal-sidebar');
            if (existing) return;
        } catch (e) { }
        if (document.getElementById('medseal-sidebar')) return;

        var mainFrames = document.getElementById('mainFrames_div');
        if (!mainFrames) {
            // Fallback: try parent frames
            try {
                mainFrames = (window.top || window.parent).document.getElementById('mainFrames_div');
            } catch (e) { }
        }
        if (!mainFrames) return; // Not on the main layout page

        var sidebar = document.createElement('div');
        sidebar.id = 'medseal-sidebar';

        // Expanded panel
        var panel = document.createElement('div');
        panel.id = 'medseal-panel';
        panel.innerHTML =
            '<div id="medseal-panel-inner">' +
            '<div id="medseal-panel-header">' +
            '<span class="agent-icon"></span>' +
            '<div style="flex:1;min-width:0">' +
            '<div class="agent-name"></div>' +
            '<div class="agent-desc"></div>' +
            '</div>' +
            '<span class="agent-status"></span>' +
            '<button class="close-btn" title="Collapse panel">«</button>' +
            '</div>' +
            '<div id="medseal-patient-ctx" class="none">' +
            '<span>⚠️</span> No patient selected' +
            '</div>' +
            '<div id="medseal-chat-messages"></div>' +
            '<div id="medseal-chat-actions"></div>' +
            '<div id="medseal-chat-input-area">' +
            '<textarea id="medseal-chat-input" placeholder="Ask the AI agent..." rows="1"></textarea>' +
            '<button id="medseal-chat-send">▶</button>' +
            '</div>' +
            '</div>';

        // Icon bar
        var iconbar = document.createElement('div');
        iconbar.id = 'medseal-iconbar';

        AGENTS.forEach(function (agent) {
            var btn = document.createElement('button');
            btn.className = 'medseal-agent-icon';
            btn.dataset.agent = agent.id;
            btn.dataset.tooltip = agent.name;
            btn.innerHTML = agent.icon + '<span class="notif-dot"></span>';
            btn.addEventListener('click', function () { switchAgent(agent.id); });
            iconbar.appendChild(btn);
        });

        var divider = document.createElement('div');
        divider.className = 'medseal-iconbar-divider';
        iconbar.appendChild(divider);

        var collapseBtn = document.createElement('button');
        collapseBtn.className = 'medseal-collapse-btn';
        collapseBtn.innerHTML = '«';
        collapseBtn.title = 'Toggle panel';
        collapseBtn.addEventListener('click', function () {
            if (isExpanded) collapsePanel();
        });
        iconbar.appendChild(collapseBtn);

        sidebar.appendChild(panel);
        sidebar.appendChild(iconbar);

        // Append as a sibling of #framesDisplay inside #mainFrames_div
        mainFrames.appendChild(sidebar);

        // Wire up panel close button
        panel.querySelector('.close-btn').addEventListener('click', collapsePanel);

        // Wire up send
        document.getElementById('medseal-chat-send').addEventListener('click', function () {
            sendMessage(document.getElementById('medseal-chat-input').value);
        });

        document.getElementById('medseal-chat-input').addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage(e.target.value);
            }
        });
    }

    // ═══ Expand / Collapse ═══
    function expandPanel() {
        var sidebar = document.getElementById('medseal-sidebar');
        if (!sidebar) return;
        sidebar.classList.add('expanded');
        isExpanded = true;
        detectPatientContext();
        if (!patientPollInterval) {
            patientPollInterval = setInterval(detectPatientContext, 3000);
        }
    }

    function collapsePanel() {
        var sidebar = document.getElementById('medseal-sidebar');
        if (!sidebar) return;
        // Save current agent state before collapsing
        if (activeAgent) saveAgentMessages(activeAgent);
        sidebar.classList.remove('expanded');
        isExpanded = false;
        activeAgent = null;
        if (patientPollInterval) { clearInterval(patientPollInterval); patientPollInterval = null; }
        document.querySelectorAll('.medseal-agent-icon').forEach(function (b) { b.classList.remove('active'); });
    }

    // ═══ Switch Agent ═══
    function switchAgent(agentId) {
        var agent = AGENTS.find(function (a) { return a.id === agentId; });
        if (!agent) return;

        // Clicking same agent while expanded → collapse
        if (activeAgent === agentId && isExpanded) {
            collapsePanel();
            return;
        }

        // Save outgoing agent
        if (activeAgent) saveAgentMessages(activeAgent);

        activeAgent = agentId;

        // Clear notification
        agentState[agentId].hasNotif = false;
        var iconBtn = document.querySelector('.medseal-agent-icon[data-agent="' + agentId + '"]');
        if (iconBtn) iconBtn.classList.remove('has-notif');

        // Update active icon
        document.querySelectorAll('.medseal-agent-icon').forEach(function (b) {
            b.classList.toggle('active', b.dataset.agent === agentId);
        });

        // Update header
        var header = document.getElementById('medseal-panel-header');
        header.querySelector('.agent-icon').textContent = agent.icon;
        header.querySelector('.agent-name').textContent = agent.name;
        header.querySelector('.agent-desc').textContent = agent.desc;

        // Update quick actions
        var actionsEl = document.getElementById('medseal-chat-actions');
        actionsEl.innerHTML = '';
        agent.actions.forEach(function (action) {
            var btn = document.createElement('button');
            btn.className = 'medseal-action-btn';
            btn.textContent = action.label;
            btn.addEventListener('click', function () {
                var pt = currentPatient ? currentPatient.name : 'the patient';
                sendMessage(action.prompt.replace(/\{patient\}/g, pt));
            });
            actionsEl.appendChild(btn);
        });

        // Update placeholder
        document.getElementById('medseal-chat-input').placeholder = 'Ask ' + agent.name + '...';

        // Restore messages
        restoreAgentMessages(agentId, agent);

        // Expand
        if (!isExpanded) expandPanel();

        document.getElementById('medseal-chat-input').focus();
    }

    // ═══ Save/Restore per-agent messages ═══
    function saveAgentMessages(agentId) {
        var messages = document.getElementById('medseal-chat-messages');
        if (messages) agentState[agentId].savedHTML = messages.innerHTML;
    }

    function restoreAgentMessages(agentId, agent) {
        var messages = document.getElementById('medseal-chat-messages');
        if (agentState[agentId].savedHTML) {
            messages.innerHTML = agentState[agentId].savedHTML;
            // Re-bind action buttons
            messages.querySelectorAll('.medseal-insert-btn').forEach(function (btn) {
                btn.onclick = function () { insertIntoField(btn.dataset.text); };
            });
            messages.querySelectorAll('.medseal-copy-btn').forEach(function (btn) {
                btn.onclick = function () {
                    navigator.clipboard.writeText(btn.dataset.text);
                    btn.textContent = '✅ Copied';
                    setTimeout(function () { btn.textContent = '📋 Copy'; }, 2000);
                };
            });
        } else {
            messages.innerHTML = '';
            addMessage(agent.welcome, 'ai', false);
        }
        messages.scrollTop = messages.scrollHeight;
    }

    // ═══ Patient Context ═══
    function detectPatientContext() {
        var ctx = document.getElementById('medseal-patient-ctx');
        if (!ctx) return;

        var pid = null, pname = null;

        try {
            var topWin = window.top || window.parent || window;

            if (topWin.application_data) {
                try {
                    var appData = topWin.application_data;
                    if (appData.patient && typeof appData.patient === 'function') {
                        var pt = appData.patient();
                        if (pt) {
                            pname = typeof pt.pname === 'function' ? pt.pname() : pt.pname;
                            pid = typeof pt.pid === 'function' ? pt.pid() : pt.pid;
                        }
                    }
                } catch (e) { }
            }

            if (!pid) {
                try {
                    var topDoc = topWin.document;
                    var sels = ['#patient_caret', '.ptName', '#ptName', '.demographics-name'];
                    for (var i = 0; i < sels.length; i++) {
                        var el = topDoc.querySelector(sels[i]);
                        if (el && el.textContent.trim()) {
                            pname = el.textContent.trim().split('\n')[0].trim();
                            break;
                        }
                    }
                    topDoc.querySelectorAll('a[href*="pid="], iframe[src*="pid="]').forEach(function (a) {
                        var m = (a.href || a.src || '').match(/pid=(\d+)/);
                        if (m && m[1] !== '0') pid = m[1];
                    });
                } catch (e) { }
            }

            if (!pid) {
                try {
                    var topDoc2 = (window.top || window.parent || window).document;
                    topDoc2.querySelectorAll('iframe').forEach(function (f) {
                        try {
                            var m = (f.src || '').match(/pid=(\d+)/);
                            if (m && m[1] !== '0') pid = m[1];
                        } catch (e) { }
                    });
                } catch (e) { }
            }

            if (!pid) {
                var m = window.location.href.match(/pid=(\d+)/);
                if (m && m[1] !== '0') pid = m[1];
            }
        } catch (e) { }

        if (pid) {
            currentPatient = { pid: pid, name: pname || 'Patient #' + pid };
            ctx.className = '';
            ctx.innerHTML = '<span>👤</span> <strong>' + currentPatient.name + '</strong> <span style="opacity:0.5;font-size:11px">(PID: ' + pid + ')</span>';
        } else if (pname) {
            currentPatient = { name: pname };
            ctx.className = '';
            ctx.innerHTML = '<span>👤</span> <strong>' + pname + '</strong>';
        } else {
            currentPatient = null;
            ctx.className = 'none';
            ctx.innerHTML = '<span>⚠️</span> No patient selected — open a chart';
        }
    }

    // ═══ Find editable fields ═══
    function findEditableFields() {
        var fields = [];
        document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]').forEach(function (el) {
            if (el.offsetParent !== null && !(el.id || '').startsWith('medseal')) {
                fields.push({ element: el, label: getFieldLabel(el) });
            }
        });
        try {
            (window.parent || window).document.querySelectorAll('iframe').forEach(function (frame) {
                try {
                    var fdoc = frame.contentDocument || frame.contentWindow.document;
                    fdoc.querySelectorAll('textarea, [contenteditable="true"]').forEach(function (el) {
                        if (el.offsetParent !== null) {
                            fields.push({ element: el, label: getFieldLabel(el) });
                        }
                    });
                } catch (e) { }
            });
        } catch (e) { }
        return fields;
    }

    function getFieldLabel(el) {
        if (el.id) {
            var label = document.querySelector('label[for="' + el.id + '"]');
            if (label) return label.textContent.trim();
        }
        if (el.name) return el.name.replace(/_/g, ' ');
        if (el.placeholder) return el.placeholder;
        var parent = el.closest('.form-group, td, div');
        if (parent) {
            var lbl = parent.querySelector('label, .field-label, th');
            if (lbl) return lbl.textContent.trim();
        }
        return el.tagName.toLowerCase();
    }

    function insertIntoField(text) {
        var fields = findEditableFields();
        if (!fields.length) {
            addMessage('⚠️ No editable fields found. Open a form first.', 'system', false);
            return;
        }
        var target = fields.reduce(function (best, f) {
            return (f.element.tagName === 'TEXTAREA') ? f : (best || f);
        }, null) || fields[0];

        var el = target.element;
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            el.value = el.value ? el.value + '\n\n' + text : text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.contentEditable === 'true') {
            el.innerHTML += '<br><br>' + text.replace(/\n/g, '<br>');
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        addMessage('✅ Inserted into "' + target.label + '". Review and Save.', 'system', false);
    }

    // ═══ Chat Messages ═══
    function addMessage(text, role, insertable) {
        var messages = document.getElementById('medseal-chat-messages');
        var wrapper = document.createElement('div');

        var msg = document.createElement('div');
        msg.className = 'medseal-msg ' + role;

        if (role === 'ai') {
            msg.innerHTML = text
                .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.*?)\*/g, '<em>$1</em>')
                .replace(/\n/g, '<br>');
        } else {
            msg.innerHTML = text;
        }

        wrapper.appendChild(msg);

        if (role === 'ai' && insertable !== false) {
            var btnRow = document.createElement('div');
            btnRow.className = 'medseal-msg-actions';

            var insertBtn = document.createElement('button');
            insertBtn.className = 'medseal-insert-btn';
            insertBtn.textContent = '📥 Insert';
            insertBtn.dataset.text = text;
            insertBtn.onclick = function () { insertIntoField(text); };

            var copyBtn = document.createElement('button');
            copyBtn.className = 'medseal-copy-btn';
            copyBtn.textContent = '📋 Copy';
            copyBtn.dataset.text = text;
            copyBtn.onclick = function () {
                navigator.clipboard.writeText(text);
                copyBtn.textContent = '✅ Copied';
                setTimeout(function () { copyBtn.textContent = '📋 Copy'; }, 2000);
            };

            btnRow.appendChild(insertBtn);
            btnRow.appendChild(copyBtn);
            wrapper.appendChild(btnRow);
        }

        messages.appendChild(wrapper);
        messages.scrollTop = messages.scrollHeight;
        return msg;
    }

    function addTypingIndicator() {
        var messages = document.getElementById('medseal-chat-messages');
        var typing = document.createElement('div');
        typing.className = 'medseal-typing';
        typing.id = 'medseal-typing';
        typing.innerHTML = '<span></span><span></span><span></span>';
        messages.appendChild(typing);
        messages.scrollTop = messages.scrollHeight;
    }

    function removeTypingIndicator() {
        var el = document.getElementById('medseal-typing');
        if (el) el.remove();
    }

    // ═══ Send Message ═══
    async function sendMessage(userMessage) {
        if (isLoading || !userMessage.trim() || !activeAgent) return;
        isLoading = true;

        var agent = AGENTS.find(function (a) { return a.id === activeAgent; });
        var input = document.getElementById('medseal-chat-input');
        var sendBtn = document.getElementById('medseal-chat-send');
        input.value = '';
        sendBtn.disabled = true;

        addMessage(userMessage, 'user', false);
        agentState[activeAgent].chatHistory.push({ role: 'user', content: userMessage });
        addTypingIndicator();

        try {
            // Ensure we have a session for this agent
            var state = agentState[activeAgent];
            if (!state.sessionId) {
                var sessRes = await fetch(AI_URL + '/sessions', { method: 'POST' });
                if (sessRes.ok) {
                    var sessData = await sessRes.json();
                    state.sessionId = sessData.session_id;
                } else {
                    throw new Error('Failed to create session');
                }
            }

            var patientId = currentPatient ? (currentPatient.pid || '0') : '0';
            var body = {
                message: userMessage,
                patient_id: patientId.toString()
            };

            var res = await fetch(AI_URL + '/openemr/sessions/' + state.sessionId + '/chat/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            removeTypingIndicator();

            if (!res.ok) {
                addMessage('⚠️ AI service error (' + res.status + ').', 'system', false);
            } else {
                var data = await res.json();
                var response = data.content || data.response || data.report || 'No response.';
                // Clean up answer tags if present
                response = response.replace(/<\/?answer>/g, '');
                addMessage(response, 'ai', true);
                agentState[activeAgent].chatHistory.push({ role: 'assistant', content: response });
                saveAgentMessages(activeAgent);
            }
        } catch (error) {
            removeTypingIndicator();
            addMessage('⚠️ Cannot reach AI Agent at ' + AI_URL, 'system', false);
        }

        isLoading = false;
        sendBtn.disabled = false;
        input.focus();
    }

    // ═══ Init ═══
    function init() {
        // Only run in the top-level window, NOT in iframes
        try {
            if (window !== window.top) return;
        } catch (e) { return; } // cross-origin iframe, skip

        if (window.location.href.indexOf('/login') >= 0 && window.location.href.indexOf('interface/main') < 0) {
            return;
        }
        // Prevent double init
        if (document.getElementById('medseal-sidebar')) return;

        createSidebar();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // Small delay to ensure OpenEMR's knockout bindings have rendered #mainFrames_div
        setTimeout(init, 300);
    }
})();
