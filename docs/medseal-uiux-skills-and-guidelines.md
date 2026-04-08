# Med-SEAL Patient App: UI/UX Skills and Design Guidelines

## Evidence-Based Interface Design for Healthcare AI Applications

**Document version:** 1.0
**Date:** March 2026
**Context:** NUS–Synapxe–IMDA AI Innovation Challenge 2026, Problem Statement 1
**App type:** Patient-facing chronic disease self-management (diabetes, hypertension, hyperlipidemia)
**Target users:** Singapore residents ages 40–85+, multilingual (EN, ZH, MS, TA), varying digital literacy
**Companion document:** Med-SEAL Typography Study and Guidance (separate document)

---

## 1. Executive summary

Designing a medical app for elderly chronic disease patients is fundamentally different from general consumer app design. The users may be in pain, anxious, vision-impaired, unfamiliar with technology, or managing cognitive decline — often simultaneously. Every design decision has a potential clinical consequence: a button too small to tap reliably can mean a missed medication dose; a confusing navigation flow can prevent a patient from reporting a dangerous symptom.

This document synthesises evidence from systematic reviews (JMIR, PMC, BMC), accessibility standards (WCAG 2.1/2.2), government health literacy guidelines (ODPHP, NHS), and platform design systems (Apple HIG, Material Design 3) into actionable UI/UX guidelines for the Med-SEAL patient app. It is structured as a skill reference — an agent or designer can consult any section independently to make evidence-based decisions.

The guidelines are organised into 12 skill areas, each with research justification, specific rules, and implementation examples.

---

## 2. Design philosophy

### 2.1 Three principles

Every design decision in the Med-SEAL app must pass through three filters, in order of priority:

**1. Safety first.** Will this design prevent the patient from misunderstanding clinical information? Medication dosages, biometric readings, and alert messages must be unambiguous under all conditions — including dim lighting, small screens, distracted attention, and impaired vision.

**2. Simplicity always.** A systematic review of mobile apps for older adults identified "simplicity" as the highest-level golden rule, finding that cognitive limitations associated with age increase the challenges of understanding and remembering how to use a complex system. Every screen should do one thing well. Every interaction should require the minimum possible effort.

**3. Empathy throughout.** The app serves people who are managing chronic illness — a stressful, often demoralising experience. The interface should feel supportive, not clinical. Warm colours, encouraging language, and celebration of progress matter as much as functional correctness.

*Sources: Queirós et al., JMIR mHealth uHealth 2023; Optimizing mobile app design for older adults, PMC 2025*

### 2.2 Design for the worst case, not the best

The Med-SEAL app must be usable by:

- A 78-year-old with diabetic retinopathy reading medication dosages
- A 55-year-old with low digital literacy using a smartphone for the first time
- A caregiver checking their parent's adherence on a crowded MRT train
- A patient with hand tremors trying to log a blood pressure reading
- A Mandarin-speaking elderly person who cannot read English

If the design works for these users, it works for everyone. If it only works for young, tech-savvy, English-speaking users, it has failed.

---

## 3. Skill 1: Layout and information architecture

### 3.1 Research basis

A 2025 systematic review on age-friendly mobile app design found that simplified navigation with linear navigation paths, clear menu hierarchies, and logical workflows was the most frequently cited factor in reducing cognitive load and improving task completion rates for older adults.

The JMIR 2023 systematic review established a golden rule: "Reduce the number of available elements and options in the screen" — stating that fewer visible elements at any given time directly improves usability for elderly users.

### 3.2 Rules

**R-L01: Maximum 5 primary navigation destinations.** The bottom tab bar must contain no more than 5 items. Research on elderly users shows that more than 5 options increases selection time and error rate. For Med-SEAL: Home, Chat, Medications, Progress, Menu.

**R-L02: Maximum 3 taps to any critical function.** A patient must be able to reach any critical function (log a medication, view a biometric reading, start a chat, call for help) within 3 taps from the home screen. Map every critical path and count taps.

**R-L03: One primary action per screen.** Each screen should have one clear primary action. A medication detail screen's primary action is "Mark as taken." A chat screen's primary action is "Send message." Secondary actions (edit, share, history) are available but visually subordinate.

**R-L04: Linear navigation over hierarchical.** Favour linear task flows (step 1 → step 2 → step 3 → done) over nested menus. Elderly users perform better with guided sequences than with deep menu exploration. For multi-step tasks (medication logging, PRO questionnaire), use a progress indicator showing current step and total steps.

**R-L05: Persistent back button and clear exit path.** Every screen must have a visible, consistently placed back button. Never trap the user in a flow without an obvious exit. The back button must be at least 44×44px and always in the same position (top-left).

**R-L06: No horizontal scrolling.** All content must be accessible through vertical scrolling only. Horizontal scrolling (including carousels and horizontal swipe galleries) is unintuitive for many elderly users. Use vertical stacking instead.

**R-L07: Avoid modals and overlays for critical information.** Modals can confuse elderly users who don't understand they're in a layered context. Use full-screen pages instead of modals for any interaction that involves clinical data. Modals are acceptable only for quick confirmations ("Mark as taken? Yes / No").

### 3.3 Screen hierarchy

| Screen | Purpose | Primary action | Maximum elements |
|---|---|---|---|
| Home | Daily overview | Start check-in | 4 cards maximum |
| Chat | AI companion conversation | Send message | Message list + input |
| Medications | Today's medication schedule | Mark as taken | Medication cards (scrollable) |
| Progress | Biometric trends and goals | View details | 3 metric cards + chart |
| Profile/Menu | Settings and support | Access settings | List items (scrollable) |

---

## 4. Skill 2: Touch targets and interaction design

### 4.1 Research basis

The JMIR 2023 systematic review found that reduced motor skills cause older users to have more trouble tapping small controls or controls that are too close together. Touchscreens require larger targets than desktop systems because fingers are bigger and less precise than mouse pointers. For older users, this is aggravated by lack of dexterity and motor skills.

The same review documented that elderly users frequently tap twice or three times unintentionally due to lack of fine motor control. WCAG 2.2 (AAA) requires a minimum touch target size of 24×24 CSS pixels, but the JMIR review and Apple HIG both recommend significantly larger targets for elderly users.

### 4.2 Rules

**R-T01: Minimum touch target 48×48dp (recommended 56×56dp).** Every tappable element must have a touch area of at least 48×48 density-independent pixels. For primary actions (medication "Take" button, send message, emergency call), use 56×56dp or larger. This exceeds WCAG 2.2's 24×24px minimum and matches Apple HIG's 44pt recommendation scaled for elderly use.

**R-T02: Minimum 12dp spacing between touch targets.** Adjacent tappable elements must have at least 12dp of non-interactive space between them. This prevents accidental taps on the wrong element, which the JMIR review identified as a frequent usability issue.

**R-T03: Favour single tap over gestures.** The JMIR review explicitly recommends favouring control tapping over gesture interactions, noting that gestures require advanced motor skills that may be difficult for older users. Swipe, pinch, long-press, and multi-finger gestures should never be the only way to perform an action — always provide a single-tap alternative.

**R-T04: Provide visual feedback on every tap.** Every tap must produce immediate visual feedback (colour change, scale animation, ripple effect). Response time must be under 100ms. Elderly users who don't see immediate feedback will tap again, causing double-actions. The feedback must be visible (not just haptic — vibration perception diminishes after age 50).

**R-T05: Debounce rapid taps.** Implement tap debouncing on all critical actions (medication logging, form submission, message sending). A minimum 500ms cooldown prevents accidental double-submissions. Show a brief "processing" state to reassure the user.

**R-T06: Large, labelled buttons over icon-only controls.** Elderly users often don't recognise abstract icons. Every primary action button must include a text label. Icons may supplement the label but must not replace it. For example: use a button labelled "Take medication" with a pill icon, not a pill icon alone.

**R-T07: Bottom-of-screen primary actions.** Place the most important action button at the bottom of the screen, within easy thumb reach. Elderly users hold phones with both hands and find bottom-screen targets easier to reach than top-screen targets. This is consistent with Android's FAB (Floating Action Button) pattern and iOS bottom safe area conventions.

---

## 5. Skill 3: Colour and contrast

### 5.1 Research basis

WCAG 2.1 AA requires a contrast ratio of at least 4.5:1 for normal text and 3:1 for large text. The WCAG 2.1 AAA level requires 7:1 for normal text and 4.5:1 for large text. The 4.5:1 ratio compensates for vision loss equivalent to 20/40 vision (typical acuity at roughly age 80). The 7:1 ratio compensates for 20/80 vision.

The JMIR systematic review states that visual acuity diminishes with age, so strong contrast between text and background is essential for older users. A 2025 systematic review on age-friendly app design listed high-contrast text as one of the most frequently cited design features for addressing age-related visual impairments.

### 5.2 Rules

**R-C01: WCAG AAA (7:1) for all body text.** Given the elderly target population, the Med-SEAL app targets WCAG 2.1 AAA contrast for all body text (18px Open Sans). This means primary text on white must be no lighter than #595959 (actual: use #1A1A1A for maximum contrast at 16.8:1).

**R-C02: WCAG AA (4.5:1) minimum for all text.** No text element in the app may fall below 4.5:1 contrast ratio, including secondary text, timestamps, and placeholder text.

**R-C03: Never use colour alone to convey meaning.** Every colour-coded element must also have a text label and/or icon. Traffic-light colour schemes (green/amber/red) for health status must always include text ("Normal" / "Caution" / "Alert") and a shape differentiator (checkmark / warning triangle / exclamation circle). This serves both colour-blind users (approximately 8% of males) and users with reduced colour discrimination due to aging.

**R-C04: Limit the colour palette to 5 functional colours.** Too many colours increase cognitive load. The Med-SEAL palette uses:

| Colour | Role | Hex (light mode) | Usage |
|---|---|---|---|
| Blue | Primary / interactive | #1565C0 | Buttons, links, agent identity |
| Green | Success / positive | #2E7D32 | Good readings, goals met, adherence confirmed |
| Amber | Caution / attention | #E65100 | Elevated readings, approaching thresholds |
| Red | Alert / critical | #C62828 | Dangerous readings, missed doses, urgent escalation |
| Gray | Neutral / secondary | #757575 | Inactive states, metadata, dividers |

**R-C05: Dark mode is mandatory.** The app must support dark mode, switching automatically based on system settings or time of day. Many elderly patients check their health app at night (before bed medication). Dark mode reduces eye strain in low-light conditions. All colour combinations must maintain WCAG AA contrast in both light and dark modes.

**R-C06: Avoid pure white (#FFFFFF) backgrounds in dark mode.** Use off-white (#FAFAFA) in light mode and near-black (#121212) in dark mode. Pure white on high-brightness screens causes glare for elderly users with cataracts or light sensitivity.

**R-C07: Use colour temperature to signal emotional tone.** Warm tones (amber, soft coral) for encouraging/motivational content. Cool tones (blue, teal) for informational/clinical content. Neutral tones (gray, off-white) for structural/navigational elements. This creates subconscious emotional signalling without relying on colour meaning.

---

## 6. Skill 4: Iconography and visual language

### 6.1 Research basis

The JMIR systematic review recommends using simple, familiar, and unambiguous language — and this extends to visual language. A 2025 healthcare UI review noted that skeuomorphic icons (resembling physical objects) reduce the learning curve for elderly users: a clipboard with checkmarks suggests health records, while a blister pack icon clearly signals medication.

Research on elderly mobile app adoption identifies lack of familiarity with abstract UI conventions as a significant barrier. Icons that are standard in tech (hamburger menu, kebab menu, share icon) are meaningless to many elderly users.

### 6.2 Rules

**R-I01: Every icon must have a text label.** No icon-only buttons for any user-facing function. The label may be placed below the icon (tab bar), beside the icon (list item), or inside the button (action button). The label is the primary identifier; the icon is supplementary.

**R-I02: Use recognisable, physical-object metaphors.** Prefer icons that represent physical objects the patient recognises. Examples: a pill for medications, a heart for vitals, a calendar for appointments, a speech bubble for chat, a chart line for progress. Avoid abstract geometric shapes or tech-specific metaphors.

**R-I03: Minimum icon size 24×24dp, recommended 32×32dp.** Icons used as interactive targets must be at least 24×24dp visible size (within a 48×48dp touch target). For primary navigation icons (tab bar), use 28-32dp visible size.

**R-I04: Consistent icon style throughout the app.** All icons must use the same style: either outlined, filled, or two-tone. Do not mix styles. For Med-SEAL, use filled icons for active/selected states and outlined icons for inactive states. This provides a clear visual distinction between selected and unselected tabs.

**R-I05: Use colour + icon + text for health status indicators.** Health status must be communicated through a triple redundancy system:
- Colour: green / amber / red background or border
- Icon: checkmark / warning triangle / exclamation circle
- Text: "Normal" / "Caution" / "Alert"

This ensures status is perceivable by users with colour blindness, low vision, and cognitive impairment simultaneously.

**R-I06: Avoid animated icons for clinical information.** Animation draws attention but can be disorienting for elderly users or those with cognitive impairment. Use animation sparingly and only for non-critical elements (loading states, success celebrations). Never animate icons that represent health status or clinical data.

---

## 7. Skill 5: Forms and data input

### 7.1 Research basis

Research on elderly mHealth app usability found that input method challenges are a significant barrier — elderly users report difficulties with typing and tapping interactions. The JMIR review recommends optimising input methods with larger touch targets and predictive text input features. A 2024 study on elderly medical app interfaces specifically recommended one-click operations and simplified data entry wherever possible.

### 7.2 Rules

**R-F01: Minimise manual text input.** Every piece of data that can be selected, toggled, or auto-filled should not require typing. Use pre-populated dropdowns, toggle switches, segmented controls, and slider inputs instead of free text fields wherever possible. For example, blood pressure input should use number steppers (tap +/- to adjust), not a keyboard entry.

**R-F02: Maximum 5 input fields per screen.** If a form requires more than 5 inputs, break it into multiple steps with a progress indicator. Each step should have 3-5 fields maximum. This reduces cognitive overload and the feeling of a "long form."

**R-F03: Large input fields (minimum 48dp height).** Text input fields must be at least 48dp tall with 16px+ text inside. The tap target for the field must cover the entire field area including the label. Small input fields are a documented barrier for elderly users.

**R-F04: Always show input labels above the field (not as placeholder text).** Placeholder text disappears when the user starts typing, removing context. Labels must be persistent, visible above the field at all times. This is a WCAG requirement and is especially critical for elderly users who may forget what they're entering.

**R-F05: Provide immediate inline validation.** Validate inputs as the user completes each field, not after form submission. Show a green checkmark for valid entries and a red error message below the field for invalid entries. Error messages must be in plain language: "Please enter a number between 60 and 200" not "Invalid input."

**R-F06: Use the appropriate keyboard type.** For numerical inputs (blood pressure, glucose, weight), show the numeric keypad. For text inputs (messages, notes), show the standard keyboard. For medication search, show the text keyboard with autocomplete suggestions. Never force the user to switch keyboard types manually.

**R-F07: Support voice input as an alternative.** Every text input field should have a microphone button for voice-to-text entry. This is critical for users with motor impairments, low vision, or low digital literacy. Voice input is processed through MERaLiON/SEA-LION for multilingual support.

**R-F08: Confirm before destructive actions.** Any action that deletes data, changes medication status, or sends a message to a clinician must require explicit confirmation. Use a clear confirmation dialog with two distinct buttons: "Confirm" (primary colour) and "Cancel" (outline style). The confirmation dialog must clearly state what will happen.

---

## 8. Skill 6: Notifications and alerts

### 8.1 Research basis

A 2025 healthcare UX review found that if a patient consistently ignores medication reminders, the UX should adapt dynamically — switching to more prominent notifications, voice alerts, or SMS reminders. The research recommends behaviour-based UX adaptation for patient compliance.

The JMIR systematic review notes that vibration feedback is not as effective as visual or auditory feedback for users over 50, as the ability to perceive vibrations diminishes with age.

### 8.2 Rules

**R-N01: Three notification tiers with distinct visual treatments.**

| Tier | Urgency | Sound | Visual | Vibration | Example |
|---|---|---|---|---|---|
| Informational | Low | Soft chime | Standard notification card | None | "Great job! 7-day medication streak" |
| Reminder | Medium | Distinct tone | Prominent card with amber accent | Short pulse | "Time to take Metformin 1000mg" |
| Alert | High | Alarm sound | Full-screen overlay, red accent | Continuous | "BP reading 182/98 — above urgent threshold" |

**R-N02: Notification text must be self-contained.** The notification preview (shown on the lock screen) must contain enough information for the patient to understand and act without opening the app. "Time to take Metformin 1000mg (morning dose)" is self-contained. "Open the app to see your reminder" is not.

**R-N03: Respect quiet hours.** Non-urgent notifications must not be delivered between 22:00 and 07:00 (adjustable by the user). Only Alert-tier notifications can override quiet hours. Medication reminders that fall within quiet hours should be rescheduled to the boundary (e.g., a 22:30 reminder moves to 22:00).

**R-N04: Progressive escalation for missed actions.** If a medication reminder is not acknowledged within 30 minutes, escalate: first to a follow-up notification with a different message, then to a voice-based nudge (if voice is enabled), then to a caregiver notification (if caregiver mode is active). Do not simply repeat the same notification — change the message to show persistence without annoyance.

**R-N05: Allow easy snooze and reschedule.** Every reminder notification must have "Take now", "Snooze 30 min", and "Skip" options directly in the notification (actionable notification on iOS/Android). The patient should never need to open the app to dismiss or snooze a reminder.

**R-N06: Never use red badges for non-urgent items.** Red notification badges trigger anxiety. Reserve red badge counts for genuinely urgent items (missed medication, critical alert). Use blue or gray badges for informational items (new chat message, education content available).

---

## 9. Skill 7: Data visualisation for health metrics

### 9.1 Research basis

A 2025 healthcare app design review found that visualisation of health data is becoming increasingly important, with data visualisation being an essential tool for helping users quickly understand their health status. The research emphasises that apps need to "tell a story" with predictive analytics and animated graphs rather than simply displaying raw numbers.

However, the elderly population requires careful simplification. The JMIR golden rule of reducing visible elements applies to charts as well — complex multi-axis charts with many data series overwhelm elderly users.

### 9.2 Rules

**R-D01: Show the current value prominently, with trend as context.** The primary display for any health metric should be the latest reading in large text (Roboto Mono, 28px). The trend chart is secondary context, displayed below. Never force the user to interpret a chart to find their current value.

**R-D02: Maximum 1 data series per chart.** Do not overlay multiple metrics on the same chart (e.g., blood pressure + glucose on one axis). Each metric gets its own chart. This reduces cognitive load and prevents misinterpretation. If comparison is needed, stack two simple charts vertically.

**R-D03: Show the goal/target line on every chart.** Every biometric chart must display the patient's target range as a highlighted zone (green band) or target line (dashed horizontal line). This gives immediate context: "Am I above or below my goal?" without requiring the patient to remember their target number.

**R-D04: Use 7-day as the default time range.** A week is the most actionable time frame for chronic disease self-management. Show 7-day data by default with options to switch to 30-day and 90-day views. Do not default to daily (too granular for trends) or yearly (too abstract for action).

**R-D05: Label data points with actual values.** On charts where individual readings matter (blood pressure, glucose), display the value label on each data point. Do not require the user to tap or hover to see values — elderly users may not discover this interaction.

**R-D06: Use colour to signal status, not aesthetics.** Data points within the healthy range are green. Points approaching the threshold are amber. Points outside the healthy range are red. This creates instant visual triage — the patient can scan the chart and immediately see whether things are getting better or worse.

**R-D07: Provide plain-language summaries below every chart.** Below every trend chart, the AI companion generates a one-sentence summary: "Your average blood pressure this week was 132/84 — slightly higher than your target of 130/80. It's been trending down from last week though." This makes the chart accessible to users who can't read graphs.

**R-D08: Avoid pie charts.** Research consistently shows that pie charts are harder to read accurately than bar charts or simple numerical comparisons. For any proportional data (adherence percentage, goal completion), use a progress bar or simple "X out of Y" format instead.

---

## 10. Skill 8: Chat interface design (AI companion)

### 10.1 Research basis

A 2025 healthcare UX review recommends using conversational UI for triage, medication guidance, and health check-ins, especially for aging users or those with accessibility needs. Voice-based interaction combined with AI-driven chatbots is identified as a key trend, with users expecting natural conversations that understand intent, not just commands.

### 10.2 Rules

**R-CH01: Chat bubbles must be distinguishable without colour.** Agent messages and patient messages must be visually distinct through position (left/right alignment), shape, and optional colour. Colour alone is not sufficient. Agent messages align left with a rounded rectangle. Patient messages align right with a different shape or stronger border radius.

**R-CH02: Maximum chat bubble width 85% of screen width.** Chat bubbles must not span the full width of the screen. Leaving 15% margin on one side provides visual breathing room and makes the conversation scannable. Long messages wrap within the bubble rather than extending the bubble width.

**R-CH03: Show the agent's identity clearly.** Every agent message should begin with a small avatar and name label ("Med-SEAL Companion"). This humanises the interaction and helps the patient understand they are talking to an AI. The avatar should be friendly but clearly non-human (abstract icon, not a photo of a person) to avoid deception.

**R-CH04: Break long agent responses into multiple bubbles.** If the agent's response exceeds 4 lines, break it into multiple message bubbles with a brief delay (300-500ms) between them. This simulates natural conversation pacing and makes the content less overwhelming.

**R-CH05: Provide suggested quick replies.** After every agent message that asks a question or offers options, display 2-4 quick reply buttons below the message. These are tappable, full-width buttons with clear labels. The patient can always type instead, but quick replies reduce the burden of typing. Quick replies are critical for PRO questionnaires delivered through chat.

**R-CH06: Support voice input and voice output.** A microphone button must be visible in the chat input area at all times. Tapping it activates voice-to-text via MERaLiON/SEA-LION. A speaker button on each agent message plays the message aloud — critical for patients with low vision or low literacy.

**R-CH07: Inline clinical data must use the clinical font.** When the agent mentions a medication name or dosage within a chat message, render it in Atkinson Hyperlegible (per the Typography document). Numerical values (BP, glucose) render in Roboto Mono. This in-context font switching ensures clinical safety even within conversational text.

**R-CH08: Never auto-scroll past unread messages.** If new agent messages arrive while the patient is reading earlier messages, show a "New messages" pill at the bottom rather than auto-scrolling. Elderly users reading slowly should not lose their place.

---

## 11. Skill 9: Onboarding and help

### 11.1 Research basis

The JMIR 2023 systematic review states that for elderly users who may not be familiar with technology, learning through exploration is not a good strategy. Proactive help, guided tutorials, and contextual hints are necessary. A 2025 systematic review on age-friendly apps confirmed that lack of familiarity with digital devices and fear of making errors contribute to anxiety and resistance toward technology adoption.

### 11.2 Rules

**R-O01: First-run experience must be guided, not skippable.** The first time the patient opens the app, a guided setup flow (3-5 screens) introduces core features: chat, medications, check-ins. Each screen shows one feature with a large illustration, a simple description, and a "Next" button. Do not allow skipping — the setup must at least show the emergency help button location.

**R-O02: Use progressive disclosure.** Don't show all features at once. On first use, show only the most essential screens (Home, Chat, Medications). Introduce Progress and Settings after the patient has used the app for 3+ days. This reduces initial overwhelm.

**R-O03: Provide contextual help on every screen.** A small "?" button on each screen opens a brief overlay explaining what this screen does and what actions are available. The help text should be in the patient's selected language at a reading level suitable for the general public (Grade 6-8 reading level).

**R-O04: Offer to connect to a human for setup.** During onboarding, provide an option: "Need help? We can walk you through this together." This connects to a human support line or a caregiver-assisted setup mode. Technology anxiety is a real barrier — human reassurance during setup significantly improves adoption.

**R-O05: Remember and restore state.** If the patient closes the app mid-task (entering a blood pressure reading, filling a PRO questionnaire), restore exactly where they left off when they return. Never force them to start over. This is critical for elderly users who may be interrupted or accidentally close the app.

**R-O06: Error messages must include the solution.** Never show "Error" or "Something went wrong" without a clear next step. Always show what happened and what to do: "We couldn't save your reading. Please check your internet connection and tap 'Try again.'" The "Try again" button must be prominent and immediately visible.

---

## 12. Skill 10: Accessibility beyond vision

### 12.1 Research basis

A 2024 study on elderly medical app usability identified accessibility features including screen reader compatibility, adjustable contrast settings, and audio cues as critical for enhancing usability for elderly users with sensory impairments. The research noted that multiple disability conditions frequently co-occur — a diabetic patient may have both vision impairment (retinopathy) and motor impairment (neuropathy) simultaneously.

### 12.2 Rules

**R-A01: Full VoiceOver / TalkBack compatibility.** Every screen element must have a meaningful accessibility label. Images must have alt text. Custom controls must expose their role, state, and value to the accessibility tree. Test every screen with VoiceOver (iOS) and TalkBack (Android) enabled.

**R-A02: Support Dynamic Type (iOS) and font scaling (Android).** The app must scale all text when the user changes their system font size setting. The layout must reflow gracefully up to 200% scaling. Test at the largest system font size on both platforms.

**R-A03: Provide audio alternatives.** Every text-based health education card, medication instruction, and PRO questionnaire must be available as spoken audio (via MERaLiON text-to-speech). A speaker icon on each content card plays the audio version.

**R-A04: Support one-handed operation.** All primary actions must be reachable with one thumb in a standard phone grip. The "reachability zone" (bottom 60% of screen) must contain all critical interactive elements. Navigation is at the bottom. Primary action buttons are at the bottom. Only passive content (headings, read-only information) is in the top 40%.

**R-A05: Provide haptic + visual + auditory feedback simultaneously.** Critical actions (medication taken, alert triggered, message sent) must provide feedback through all three channels: a visual state change (button turns green), a sound (confirmation chime), and a haptic pulse. The user may not perceive any single channel — triple redundancy ensures the feedback is received.

**R-A06: Never rely on time-limited interactions.** No element should disappear or become inaccessible after a timeout. Toast notifications must persist until dismissed. Loading states must not timeout without a retry option. Elderly users operate at varying speeds — the app must wait for them, not rush them.

**R-A07: Reduce motion for vestibular sensitivity.** Respect the "Reduce Motion" system setting (iOS) and "Remove Animations" (Android). When enabled, replace all animations with instant state changes. Parallax effects, spring animations, and auto-scrolling must all be disabled. Some elderly users experience dizziness or disorientation from screen motion.

---

## 13. Skill 11: Multilingual and cultural design

### 13.1 Research basis

A 2025 systematic review on age-friendly app design emphasises the need for culturally inclusive mobile applications. In Singapore's multilingual context (EN, ZH, MS, TA), culturally appropriate design goes beyond translation — it requires understanding how different cultural groups interact with health concepts, technology, and authority.

The challenge specifically recommends using MERaLiON and SEA-LION, which are designed to handle complex language-switching communication styles and cultural nuances common in Singapore.

### 13.2 Rules

**R-M01: Language selection must be accessible from every screen.** A persistent language toggle (e.g., "EN | 中 | BM | த") must be visible on the home screen and accessible from the settings menu. Language can also be auto-detected from the system locale but must be manually overridable.

**R-M02: All clinical content must be available in all 4 languages.** Medication names, dosage instructions, health education content, and alert messages must be professionally translated (not machine-translated) into all four official languages. The agent (MERaLiON/SEA-LION) handles conversational content dynamically, but static clinical content must be pre-verified by bilingual medical professionals.

**R-M03: Account for text expansion in CJK and Tamil.** Chinese text is typically 30-50% shorter than equivalent English text. Tamil text can be 20-40% longer than English. Malay text is roughly equivalent to English in length. UI layouts must accommodate the longest possible text without truncation or overflow. Test every screen in Tamil (typically the longest) as the boundary case.

**R-M04: Use culturally appropriate health metaphors.** Health communication metaphors vary by culture. For Chinese-speaking users, traditional concepts (e.g., "balance" and "harmony") may resonate more than clinical directness. For Malay-speaking users, community and family framing is important. The companion agent's tone should adapt to the user's language selection — this is handled by MERaLiON/SEA-LION's cultural awareness.

**R-M05: Right-to-left (RTL) readiness.** While none of the four Singapore languages are RTL, the app should be architecturally RTL-ready for future ASEAN expansion (e.g., Jawi script Malay in Malaysia/Brunei). Use logical properties (start/end) instead of physical properties (left/right) in CSS/layout definitions.

**R-M06: Use universal icons with culturally neutral imagery.** Avoid icons or imagery that are culturally specific to one group. A "thumbs up" icon is not universally positive. Use checkmarks for confirmation, hearts for wellbeing, and abstract progress indicators rather than culturally loaded symbols.

**R-M07: Support code-switching in chat.** Singapore users frequently mix languages within a single sentence (Singlish, EN-ZH mixing). The chat input must handle mixed-script entry without errors. The companion agent (SEA-LION) must understand and respond appropriately to code-switched messages.

---

## 14. Skill 12: Emotional design and patient psychology

### 14.1 Research basis

Research on chronic disease self-management consistently shows that patient engagement declines over time — the "novelty effect" wears off within 2-4 weeks. Healthcare UX reviews in 2025 identify gamification elements (progress bars, badges, streaks) as effective in motivating users to stay consistent with care routines.

However, gamification in healthcare must be handled carefully — celebrating a "7-day streak" is encouraging, but a "broken streak" notification can be demoralising for a patient who is already struggling.

### 14.2 Rules

**R-E01: Celebrate progress, never punish lapses.** When the patient achieves a goal (7-day adherence streak, BP within target), celebrate with a cheerful animation and positive message. When the patient misses a dose or breaks a streak, never show "Streak broken!" — instead, show "Yesterday was tough. Today is a fresh start. Want to chat about what got in the way?" Empathetic reframing is clinically more effective than punishment.

**R-E02: Use warm, human language — never clinical jargon.** The agent and UI text should say "Your blood sugar was a bit high today" not "Hyperglycaemic episode detected." Medical terminology can be available on request ("What does this mean?") but should never be the default display language.

**R-E03: Provide a sense of control, not surveillance.** The patient must always feel that the app is helping them, not monitoring them. Language should be "Your readings" (ownership) not "We detected" (surveillance). Settings should give the patient full control over notification frequency, data sharing, and caregiver access.

**R-E04: Acknowledge difficulty and validate emotions.** When the patient reports negative emotions through PROs or conversation, the agent should acknowledge them before offering solutions: "Managing diabetes every day is really hard. It's okay to feel frustrated. Would you like to talk about what's been challenging?" Jumping straight to "Here's what you should do" dismisses the patient's emotional state.

**R-E05: Use micro-celebrations for daily habits.** A small visual reward (checkmark animation, a brief colour burst on the card) when the patient logs a medication, records a reading, or completes a check-in. These micro-celebrations reinforce habit formation without being patronising. Keep celebrations brief (under 1 second) and subtle.

**R-E06: Provide visible progress over time.** A "My journey" or "Progress" section showing the patient's improvement over weeks and months (HbA1c trending down, adherence rate improving) gives a sense of accomplishment that sustains engagement. Historical context helps the patient see that their efforts are working.

**R-E07: Design for bad days.** Some days the patient will feel terrible — in pain, fatigued, or overwhelmed. On these days, the app should offer a "Minimal mode" where only the bare essentials are shown: today's medications and an emergency contact button. The companion agent should recognise signs of distress (short, terse messages, missed check-ins) and offer reduced engagement rather than the full suite.

---

## 15. Compliance and regulatory alignment

### 15.1 Accessibility standards

| Standard | Level | Med-SEAL target |
|---|---|---|
| WCAG 2.1 | AA (all criteria) | Mandatory |
| WCAG 2.1 | AAA (contrast, text spacing, reflow) | Mandatory for text; best-effort for other criteria |
| WCAG 2.2 | AA (focus visible, target size) | Mandatory |
| Apple HIG | Accessibility guidelines | Mandatory for iOS build |
| Material Design 3 | Accessibility guidelines | Mandatory for Android build |

### 15.2 Healthcare-specific standards

| Standard | Requirement | Med-SEAL implementation |
|---|---|---|
| HIPAA (if US deployment) | Patient data protection | End-to-end encryption, SMART on FHIR auth |
| PDPA (Singapore) | Personal data protection | Consent management, data minimisation |
| HSA CSDT (Singapore) | Clinical decision support tools | Disclaimer on AI-generated advice, clinician-in-the-loop |
| FDA SaMD (if regulated) | Software as Medical Device | Provenance chain, model version tracking |
| ODPHP Health Literacy | Health content readability | Grade 6-8 reading level, sans-serif fonts, 16px+ |

### 15.3 App store requirements

| Platform | Requirement | Implementation |
|---|---|---|
| Apple App Store | Health app review guidelines | Medical disclaimer, no diagnostic claims |
| Google Play Store | Health app policy | Accurate health information, privacy disclosure |
| Both | Accessibility metadata | Declare accessibility features in app listing |

---

## 16. Testing and validation protocol

### 16.1 Usability testing with target population

Before launch, conduct usability testing with a minimum of 15 participants from the target population:

| Participant group | Count | Characteristics |
|---|---|---|
| Elderly patients (60-75) | 5 | Active smartphone users with 3H conditions |
| Elderly patients (75+) | 5 | Limited digital literacy, may need caregiver assistance |
| Caregivers | 3 | Family members managing care for elderly parent |
| Low-vision users | 2 | Diabetic retinopathy or other vision impairment |

### 16.2 Test scenarios

| # | Scenario | Success criteria | Skill areas tested |
|---|---|---|---|
| 1 | Log a medication dose | Complete in under 3 taps, no errors | Touch targets, layout, forms |
| 2 | Read a blood pressure trend | Correctly identify if trend is improving/declining | Data visualisation, colour |
| 3 | Complete a 5-question PRO check-in | Complete in under 3 minutes via chat | Chat interface, forms |
| 4 | Find the emergency contact button | Find within 10 seconds from any screen | Layout, navigation |
| 5 | Switch language from English to Chinese | Complete without assistance | Multilingual design |
| 6 | Respond to a medication reminder notification | Acknowledge from lock screen without opening app | Notifications |
| 7 | Understand a health education card | Correctly paraphrase the key message | Emotional design, typography |
| 8 | Navigate with VoiceOver/TalkBack enabled | Complete scenario 1 using screen reader only | Accessibility |

### 16.3 Metrics to collect

| Metric | Method | Target |
|---|---|---|
| Task completion rate | Observation | > 90% for all scenarios |
| Time to complete | Stopwatch | Within 2x of a 30-year-old baseline |
| Error rate | Observation + logging | < 10% across all scenarios |
| System Usability Scale (SUS) | Post-test questionnaire | > 70 (above average) |
| Net Promoter Score (NPS) | Post-test question | > 50 |
| Qualitative satisfaction | Interview | Identify top 3 pain points for iteration |

---

## 17. References

1. Queirós A, Cerqueira M, Santos M, Rocha NP. "Design Guidelines of Mobile Apps for Older Adults: Systematic Review and Thematic Analysis." JMIR mHealth uHealth 2023;11:e43186. doi:10.2196/43186

2. "Optimizing mobile app design for older adults: systematic review of age-friendly design." PMC 2025. doi:10.1007/s40520-025-03157-7

3. ODPHP. "Health Literacy Online: A Guide to Simplifying the User Experience." U.S. Department of Health and Human Services.

4. W3C. "Web Content Accessibility Guidelines (WCAG) 2.1." W3C Recommendation. w3.org/TR/WCAG21

5. W3C. "WCAG 2.2." W3C Recommendation. w3.org/TR/WCAG22

6. Apple Inc. "Human Interface Guidelines." developer.apple.com/design/human-interface-guidelines

7. Google. "Material Design 3." m3.material.io

8. NHS England. "NHS Identity Guidelines." england.nhs.uk/nhsidentity

9. "Usability evaluation of mHealth apps for elderly individuals: a scoping review." BMC Medical Informatics and Decision Making 2022;22:317. doi:10.1186/s12911-022-02064-5

10. "Examining the usability and accessibility challenges in mobile health applications for older adults." ScienceDirect 2024.

11. "UI/UX Design Principles for Mobile Health Applications." JRPS 2024;15(3).

12. "Healthcare UI Design 2026: Best Practices + Examples." Eleken 2026.

13. "Design Considerations for Mobile Health Applications Targeting Older Adults." PMC 2022. doi:10.3389/fdgth.2021.796885

14. Braille Institute. "Atkinson Hyperlegible Font." brailleinstitute.org/freefont

15. Nielsen J. "10 Usability Heuristics for User Interface Design." Nielsen Norman Group.

---

## 18. Quick reference: Design token summary

For rapid implementation, here are the key design tokens:

### Spacing

| Token | Value | Usage |
|---|---|---|
| space-xs | 4dp | Inline element spacing |
| space-sm | 8dp | Within-card element spacing |
| space-md | 16dp | Between-card spacing |
| space-lg | 24dp | Section spacing |
| space-xl | 32dp | Screen section separation |

### Corner radius

| Token | Value | Usage |
|---|---|---|
| radius-sm | 8dp | Input fields, small buttons |
| radius-md | 12dp | Cards, containers |
| radius-lg | 16dp | Bottom sheets, large cards |
| radius-full | 9999dp | Pills, avatars, circular buttons |

### Elevation

| Token | Value | Usage |
|---|---|---|
| elevation-0 | none | Flat elements, inline content |
| elevation-1 | 0 1dp 3dp rgba(0,0,0,0.12) | Cards, input fields |
| elevation-2 | 0 4dp 6dp rgba(0,0,0,0.15) | Floating buttons, bottom navigation |
| elevation-3 | 0 8dp 16dp rgba(0,0,0,0.18) | Bottom sheets, dialogs |

### Touch targets

| Token | Value | Usage |
|---|---|---|
| target-min | 48dp | Minimum for any interactive element |
| target-primary | 56dp | Primary action buttons |
| target-spacing | 12dp | Minimum gap between targets |

### Animation

| Token | Value | Usage |
|---|---|---|
| duration-instant | 100ms | Tap feedback, colour change |
| duration-fast | 200ms | Button state transitions |
| duration-normal | 300ms | Page transitions, card expansions |
| duration-slow | 500ms | Success celebrations, loading states |
| easing-default | cubic-bezier(0.4, 0, 0.2, 1) | Standard transitions |
| easing-enter | cubic-bezier(0, 0, 0.2, 1) | Elements entering the screen |
| easing-exit | cubic-bezier(0.4, 0, 1, 1) | Elements leaving the screen |

---

## 19. Summary: The 12 skills

| # | Skill | Core principle | Key metric |
|---|---|---|---|
| 1 | Layout and information architecture | One action per screen, 3 taps to anything | Navigation depth ≤ 3 |
| 2 | Touch targets and interaction | 48dp minimum, single tap preferred | Tap error rate < 5% |
| 3 | Colour and contrast | WCAG AAA for body text, triple redundancy | Contrast ratio ≥ 7:1 |
| 4 | Iconography and visual language | Always labelled, physical-object metaphors | Icon recognition > 90% |
| 5 | Forms and data input | Minimise typing, voice alternative always | Completion rate > 95% |
| 6 | Notifications and alerts | Self-contained, three tiers, progressive escalation | Response rate > 60% |
| 7 | Data visualisation | Current value prominent, goal line visible | Comprehension > 85% |
| 8 | Chat interface | Quick replies, voice I/O, broken responses | Message read rate > 90% |
| 9 | Onboarding and help | Guided, progressive, human fallback | Setup completion > 80% |
| 10 | Accessibility | Triple-channel feedback, screen reader compatible | WCAG 2.1 AA pass |
| 11 | Multilingual and cultural | 4 languages, cultural adaptation, code-switching | All content in all languages |
| 12 | Emotional design | Celebrate progress, never punish, empathetic reframing | SUS > 70, NPS > 50 |

This document is a living reference. As usability testing reveals new insights and the patient population provides feedback, these guidelines should be updated. Good medical app design is never finished — it evolves with the patients it serves.
