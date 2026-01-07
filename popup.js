document.addEventListener('DOMContentLoaded', () => {
    const toggleBtn = document.getElementById('toggleSelectionBtn');
    const messageList = document.getElementById('messageList');
    const contextInput = document.getElementById('contextInput');
    const analyzeBtn = document.getElementById('analyzeBtn');
    const resultContainer = document.getElementById('resultContainer');
    
    // Inputs removed, using env.js CONFIG instead
    
    const loadingIndicator = document.getElementById('loadingIndicator');
    
    // Result Elements
    const resultHeadline = document.getElementById('resultHeadline');
    const statSilence = document.getElementById('statSilence');
    const statPower = document.getElementById('statPower');
    const resultReasoning = document.getElementById('resultReasoning');
    const resultRecommendation = document.getElementById('resultRecommendation');
    
    // Chat Elements
    const chatSection = document.getElementById('chatSection');
    const chatHistoryDiv = document.getElementById('chatHistory');
    const chatInput = document.getElementById('chatInput');
    const sendChatBtn = document.getElementById('sendChatBtn');


    const themeToggle = document.getElementById('themeToggle');

    function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }

    function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    if (themeToggle) {
        themeToggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
    }
    }

    function initTheme() {
    chrome.storage.local.get(['theme'], (result) => {
        const theme = result.theme || systemTheme();
        applyTheme(theme);
    });
    }

    // Init early
    initTheme();

    // Toggle click
    if (themeToggle) {
    themeToggle.addEventListener('click', () => {
        const current = document.documentElement.dataset.theme || systemTheme();
        const next = current === 'dark' ? 'light' : 'dark';
        chrome.storage.local.set({ theme: next });
        applyTheme(next);
    });
    }


    const lights = {
        red: document.getElementById('lightRed'),
        yellow: document.getElementById('lightYellow'),
        green: document.getElementById('lightGreen')
    };

    let chatHistory = []; 

    // Initialize UI state
    loadMessages();
    checkSelectionMode();

    // Listen for storage changes
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            if (changes.messages) renderMessages(changes.messages.newValue);
            if (changes.selectionMode) updateToggleButton(changes.selectionMode.newValue);
        }
    });

    // Azure Settings are now static in env.js

    // Toggle Selection Mode
    toggleBtn.addEventListener('click', () => {
        chrome.storage.local.get(['selectionMode'], (result) => {
            const newMode = !result.selectionMode;
            chrome.storage.local.set({ selectionMode: newMode });
            updateToggleButton(newMode);
        });
    });

    // Analyze Button
    // -----------------------------
    // PRIVACY LAYER
    
    function normalizeEndpoint(endpoint) {
    return endpoint.replace(/\/+$/, '');
    }

    function findTimeSpans(text) {
    // 24h "14:30", 12h "2:30pm", "2 pm"
    const patterns = [
        /\b([01]?\d|2[0-3]):[0-5]\d(\s?(a\.?m\.?|p\.?m\.?))?\b/gi,
        /\b(1[0-2]|[1-9])\s?(a\.?m\.?|p\.?m\.?)\b/gi
    ];
    const spans = [];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) {
        spans.push({ start: m.index, end: m.index + m[0].length, replacement: "[Time]" });
        }
    }
    return spans;
    }

    function applySpans(text, spans) {
    if (!spans || spans.length === 0) return text;
    // Replace from end → start so indexes don’t shift
    const sorted = spans
        .filter(s => Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end > s.start && s.end <= text.length)
        .sort((a, b) => b.start - a.start);

    let out = text;
    for (const s of sorted) {
        out = out.slice(0, s.start) + s.replacement + out.slice(s.end);
    }
    return out;
    }

    function entityToSpan(entity) {
    // Azure returns: { offset, length, category, ... }
    const cat = entity.category || "PII";
    const label = cat.replace(/([a-z])([A-Z])/g, '$1 $2'); // PhoneNumber -> Phone Number
    return {
        start: entity.offset,
        end: entity.offset + entity.length,
        replacement: `[${label}]`,
        category: cat
    };
    }

    async function callAzurePiiRedaction(endpoint, apiKey, texts) {
    if (!endpoint || !apiKey) return { results: { documents: texts.map((t, i) => ({ id: String(i+1), entities: [] })) } };
    
    const url = `${normalizeEndpoint(endpoint)}/language/:analyze-text?api-version=2024-11-01`;

    const documents = texts.map((t, i) => ({
        id: String(i + 1),
        language: "en",
        text: t
    }));

    const body = {
        kind: "PiiEntityRecognition",
        analysisInput: { documents },
        parameters: { modelVersion: "latest" }
    };

    const resp = await fetch(url, {
        method: "POST",
        headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": apiKey
        },
        body: JSON.stringify(body)
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const msg = data?.error?.message || JSON.stringify(data) || resp.statusText;
        throw new Error(`Azure PII Error ${resp.status}: ${msg}`);
    }
    return data;
    }

    async function redactMessagesWithAzurePII(messages, endpoint, apiKey) {
    const texts = messages.map(m => m.text || "");
    const pii = await callAzurePiiRedaction(endpoint, apiKey, texts);

    const docs = pii?.results?.documents || [];
    const summary = {};

    const redactedMessages = messages.map((m, idx) => {
        const d = docs[idx] || {};
        const entities = Array.isArray(d.entities) ? d.entities : [];

        const entitySpans = entities.map(entityToSpan);
        for (const s of entitySpans) summary[s.category] = (summary[s.category] || 0) + 1;

        const timeSpans = findTimeSpans(m.text || "");
        const redactedText = applySpans(m.text || "", [...entitySpans, ...timeSpans]);

        return { ...m, text: redactedText };
    });

    return { redactedMessages, piiSummary: summary };
    }

    analyzeBtn.addEventListener('click', async () => {
        // Use Global CONFIG from env.js
        const endpoint = CONFIG.AZURE_OPENAI_ENDPOINT;
        const deployment = CONFIG.AZURE_OPENAI_DEPLOYMENT;
        const key = CONFIG.AZURE_OPENAI_KEY;

        if (!endpoint || !deployment || !key) {
            alert('Missing Azure OpenAI settings. Please check env.js');
            return;
        }

        chrome.storage.local.get(['messages'], async (result) => {
            const messages = result.messages || [];
            const context = contextInput.value.trim();

            if (messages.length === 0) {
                alert('Please select at least one message to analyze.');
                return;
            }

            // Reset UI
            resultContainer.classList.add('hidden');
            chatSection.classList.add('hidden');
            loadingIndicator.classList.remove('hidden');
            analyzeBtn.disabled = true;
            Object.values(lights).forEach(l => l.classList.remove('active'));
            chatHistory = []; // Reset chat history
            chatHistoryDiv.innerHTML = '';

            const payload = {
                request_type: "analysis",
                current_snapshot_time: new Date().toISOString(),
                user_context_notes: context,
                selected_messages: messages
            };

            const prompt = constructInitialPrompt(context, payload);

            try {
                const response = await callAzureOpenAI(endpoint, deployment, key, prompt);
                const jsonResponse = parseAzureOpenAIResponse(response);
                
                if (jsonResponse) {
                    displayResult(jsonResponse);
                    // Add to chat history as context
                    chatHistory.push({ role: 'user', parts: [{ text: prompt }] });
                    chatHistory.push({ role: 'model', parts: [{ text: JSON.stringify(jsonResponse) }] });
                    chatSection.classList.remove('hidden');
                } else {
                    alert('Failed to parse analysis result.');
                }
            } catch (error) {
                console.error(error);
                alert('Error analyzing: ' + error.message);
            } finally {
                loadingIndicator.classList.add('hidden');
                analyzeBtn.disabled = false;
            }
        });
    });

    // Chat Functionality
    sendChatBtn.addEventListener('click', handleChatSubmit);
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleChatSubmit();
    });

    async function handleChatSubmit() {
        const text = chatInput.value.trim();
        if (!text) return;

        const endpoint = CONFIG.AZURE_OPENAI_ENDPOINT;
        const deployment = CONFIG.AZURE_OPENAI_DEPLOYMENT;
        const key = CONFIG.AZURE_OPENAI_KEY;

        if (!endpoint || !deployment || !key) {
            alert('Missing Azure OpenAI settings. Please check env.js');
            return;
        }

        appendChatMessage('user', text);
        chatInput.value = '';
        
        // Add user message to history
        chatHistory.push({ role: 'user', parts: [{ text: text }] });

        try {
            // Show temporary loading state in chat?
            const loadingMsg = appendChatMessage('ai', 'Thinking...');
            
            const response = await callAzureOpenAIChat(endpoint, deployment, key, chatHistory);
            
            // Remove loading message
            loadingMsg.remove();
            
            const aiText = response.choices[0].message.content;
            appendChatMessage('ai', aiText);
            
            // Add AI response to history
            chatHistory.push({ role: 'model', parts: [{ text: aiText }] });

        } catch (error) {
            console.error(error);
            appendChatMessage('ai', 'Error: ' + error.message);
        }
    }

    function appendChatMessage(role, text) {
        const div = document.createElement('div');
        div.className = `chat-message ${role}`;
        div.textContent = text;
        chatHistoryDiv.appendChild(div);
        chatHistoryDiv.scrollTop = chatHistoryDiv.scrollHeight;
        return div;
    }

    function constructInitialPrompt(userContext, payload) {
        return `
# ROLE & OBJECTIVE
You are the "TimingOS Engine," a sophisticated Game Theory Strategist for interpersonal communication. Your goal is not to write text, but to analyze the *timing* and *leverage* of a conversation to dictate the optimal next move.

You must analyze the provided conversation data to determine:
1. Power Dynamics (Who has the leverage?)
2. Momentum (Is the conversation heating up or cooling down?)
3. Latency (Is the silence meaningful?)

# INPUT DATA
You will be provided with three data points:

1. [USER_CONTEXT]: Notes from the user about their goal or feelings.
2. [PRIOR_ANALYSIS]: A summary of your previous advice (if this is a follow-up debate).
3. [MESSAGE_PAYLOAD]: A JSON object containing the selected messages and the exact "Snapshot Time" (when the user asked for help).

# CRITICAL LOGIC: THE SILENCE CALCULATION
You must calculate the "Silence Duration" by comparing the \`timestamp\` of the last message in [MESSAGE_PAYLOAD] against the \`current_snapshot_time\`.
- If the last message was from the *User* and silence is > 4 hours, leverage is likely dropping.
- If the last message was from the *Other Party* and silence is > 4 hours, the User has high leverage (Cooling Phase).

# OUTPUT SCHEMA
You must output a single JSON object. Do not include markdown formatting or conversational filler.

{
  "signal": "GREEN" | "YELLOW" | "RED",
  "headline": "A short, punchy 5-word summary (e.g., 'Leverage High: Push Now')",
  "analysis": {
    "silence_duration": "Calculated time difference (e.g., '4h 12m')",
    "power_dynamic": "Who holds the cards? (User/Them/Neutral)",
    "reasoning": "2-3 sentences explaining the game theory logic. Focus on latency and scarcity."
  },
  "recommendation": "Specific strategic instruction (e.g., 'Wait 2 more hours to signal abundance' or 'Reply immediately to maintain momentum')."
}

# START INPUTS

[USER_CONTEXT]:
${userContext}

[PRIOR_ANALYSIS]:
(No prior analysis - this is the first run)

[MESSAGE_PAYLOAD]:
${JSON.stringify(payload, null, 2)}
`;
    }

    async function callAzureOpenAI(endpoint, deployment, key, prompt) {
        const url = `${normalizeEndpoint(endpoint)}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-15-preview`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': key
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.7,
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Azure OpenAI Error ${response.status}: ${errorText}`);
        }
        return await response.json();
    }

    async function callAzureOpenAIChat(endpoint, deployment, key, history) {
        const url = `${normalizeEndpoint(endpoint)}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-15-preview`;
        
        const messages = history.map(h => ({
            role: h.role === 'model' ? 'assistant' : 'user', 
            content: h.parts[0].text
        }));

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': key },
            body: JSON.stringify({
                messages: messages
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Azure OpenAI Error ${response.status}: ${errorText}`);
        }
        return await response.json();
    }

    function parseAzureOpenAIResponse(response) {
        try {
            const text = response.choices[0].message.content;
            const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(jsonStr);
        } catch (e) {
            console.error("Failed to parse JSON", e);
            return null;
        }
    }

    function displayResult(data) {
        resultContainer.classList.remove('hidden');
        
        // Traffic Light
        const signal = data.signal.toLowerCase();
        if (lights[signal]) lights[signal].classList.add('active');

        // Text Content
        resultHeadline.textContent = data.headline;
        statSilence.textContent = data.analysis.silence_duration;
        statPower.textContent = data.analysis.power_dynamic;
        resultReasoning.textContent = data.analysis.reasoning;
        resultRecommendation.textContent = data.recommendation;
    }

    // --- Existing Helper Functions ---
    function loadMessages() {
        chrome.storage.local.get(['messages'], (result) => {
            renderMessages(result.messages || []);
        });
    }

    function renderMessages(messages) {
        messageList.innerHTML = '';
        if (messages.length === 0) {
            messageList.innerHTML = '<div class="empty-state">No messages selected yet.</div>';
            return;
        }
        messages.forEach((msg, index) => {
            const item = document.createElement('div');
            item.className = 'message-item';
            
            // Format time
            const date = new Date(msg.timestamp);
            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            // Meta info (Sender • Time)
            const metaDiv = document.createElement('div');
            metaDiv.className = 'message-meta';
            const senderName = msg.sender === 'Me' ? 'You' : (msg.sender || 'Unknown');
            metaDiv.innerHTML = `<strong>${senderName}</strong> • ${timeStr} <span class="platform-tag">${msg.platform ? msg.platform.replace('www.', '').replace('web.', '').split('.')[0] : 'web'}</span>`;

            // Text content
            const textSpan = document.createElement('div');
            textSpan.className = 'message-text';
            textSpan.textContent = msg.text.length > 150 ? msg.text.substring(0, 150) + '...' : msg.text;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.textContent = '×';
            removeBtn.title = 'Remove message';
            removeBtn.onclick = () => removeMessage(index);

            // Structure
            const contentDiv = document.createElement('div');
            contentDiv.style.flex = '1';
            contentDiv.appendChild(metaDiv);
            contentDiv.appendChild(textSpan);

            item.appendChild(contentDiv);
            item.appendChild(removeBtn);
            
            // Highlight if "Me"
            if (msg.isMe) {
                 item.style.borderLeft = '3px solid #4caf50';
            }

            messageList.appendChild(item);
        });
    }

    function removeMessage(index) {
        chrome.storage.local.get(['messages'], (result) => {
            const messages = result.messages || [];
            messages.splice(index, 1);
            chrome.storage.local.set({ messages: messages });
        });
    }

    function checkSelectionMode() {
        chrome.storage.local.get(['selectionMode'], (result) => {
            updateToggleButton(!!result.selectionMode);
        });
    }

    function updateToggleButton(isActive) {
        if (isActive) {
            toggleBtn.textContent = 'Selection Mode: ON';
            toggleBtn.classList.add('active');
        } else {
            toggleBtn.textContent = 'Toggle Selection Mode';
            toggleBtn.classList.remove('active');
        }
    }
});
