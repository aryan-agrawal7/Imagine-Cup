document.addEventListener('DOMContentLoaded', () => {
    const toggleBtn = document.getElementById('toggleSelectionBtn');
    const messageList = document.getElementById('messageList');
    const contextInput = document.getElementById('contextInput');
    const analyzeBtn = document.getElementById('analyzeBtn');
    const resultContainer = document.getElementById('resultContainer');
    const apiKeyInput = document.getElementById('apiKeyInput');
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
    const checkModelsBtn = document.getElementById('checkModelsBtn');

    const lights = {
        red: document.getElementById('lightRed'),
        yellow: document.getElementById('lightYellow'),
        green: document.getElementById('lightGreen')
    };

    let chatHistory = []; // Stores {role: 'user'|'model', parts: [{text: ...}]}
    let activeModel = 'gemini-2.5-flash-lite'; // Default fallback

    // Initialize UI state
    loadMessages();
    checkSelectionMode();
    loadApiKey();

    // Listen for storage changes
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            if (changes.messages) renderMessages(changes.messages.newValue);
            if (changes.selectionMode) updateToggleButton(changes.selectionMode.newValue);
            if (changes.activeModel) activeModel = changes.activeModel.newValue;
        }
    });

    // Save API Key on change
    apiKeyInput.addEventListener('change', () => {
        chrome.storage.local.set({ geminiApiKey: apiKeyInput.value.trim() });
    });

    // Check Models Button
    checkModelsBtn.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            alert('Please enter an API Key first.');
            return;
        }
        
        checkModelsBtn.textContent = 'Checking...';
        checkModelsBtn.disabled = true;

        try {
            const models = await listAvailableModels(apiKey);
            console.log('Available Models:', models);
            
            // Find the best model that supports generateContent
            const contentModels = models.filter(m => 
                m.supportedGenerationMethods && 
                m.supportedGenerationMethods.includes('generateContent')
            );

            if (contentModels.length > 0) {
                // Prioritize "Lite" and "Flash" models for better free tier quotas
                const preferredOrder = [
                    'gemini-2.5-flash-lite',
                ];
                let selectedModel = contentModels[0].name.replace('models/', '');

                for (const pref of preferredOrder) {
                    const found = contentModels.find(m => m.name.includes(pref));
                    if (found) {
                        selectedModel = found.name.replace('models/', '');
                        break;
                    }
                }

                chrome.storage.local.set({ activeModel: selectedModel });
                activeModel = selectedModel;
                alert(`Success! Connected. Using model: ${selectedModel}\n\nAvailable: ${contentModels.map(m => m.name).join(', ')}`);
            } else {
                alert('Connected, but no models support "generateContent".\n\nAvailable: ' + models.map(m => m.name).join(', '));
            }
        } catch (e) {
            alert('Connection Failed: ' + e.message);
        } finally {
            checkModelsBtn.textContent = 'Check Connection & Models';
            checkModelsBtn.disabled = false;
        }
    });

    function loadApiKey() {
        chrome.storage.local.get(['geminiApiKey', 'activeModel'], (result) => {
            if (result.geminiApiKey) apiKeyInput.value = result.geminiApiKey;
            if (result.activeModel) activeModel = result.activeModel;
        });
    }

    // Toggle Selection Mode
    toggleBtn.addEventListener('click', () => {
        chrome.storage.local.get(['selectionMode'], (result) => {
            const newMode = !result.selectionMode;
            chrome.storage.local.set({ selectionMode: newMode });
            updateToggleButton(newMode);
        });
    });

    // Analyze Button
    analyzeBtn.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            alert('Please enter a valid Gemini API Key.');
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
                const response = await callGemini(apiKey, prompt);
                const jsonResponse = parseGeminiResponse(response);
                
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

        const apiKey = apiKeyInput.value.trim();
        appendChatMessage('user', text);
        chatInput.value = '';
        
        // Add user message to history
        chatHistory.push({ role: 'user', parts: [{ text: text }] });

        try {
            // Show temporary loading state in chat?
            const loadingMsg = appendChatMessage('ai', 'Thinking...');
            
            const response = await callGeminiChat(apiKey, chatHistory);
            
            // Remove loading message
            loadingMsg.remove();
            
            const aiText = response.candidates[0].content.parts[0].text;
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

    async function listAvailableModels(apiKey) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        const response = await fetch(url);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error ${response.status}: ${errorText}`);
        }
        const data = await response.json();
        return data.models || [];
    }

    async function callGemini(apiKey, prompt) {
        // Use the dynamically selected model, or fallback to gemini-2.5-flash-lite
        const modelToUse = activeModel || 'gemini-2.5-flash-lite';
        console.log('Calling Gemini with model:', modelToUse);

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 429) {
                throw new Error('Quota Exceeded. Try switching to a "Flash" or "Lite" model using the Check Connection button.');
            }
            throw new Error(`Gemini API Error ${response.status}: ${errorText}`);
        }
        return await response.json();
    }

    async function callGeminiChat(apiKey, history) {
        const modelToUse = activeModel || 'gemini-2.5-flash-lite';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: history
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 429) {
                throw new Error('Quota Exceeded. Try switching to a "Flash" or "Lite" model using the Check Connection button.');
            }
            throw new Error(`Gemini API Error ${response.status}: ${errorText}`);
        }
        return await response.json();
    }

    function parseGeminiResponse(response) {
        try {
            const text = response.candidates[0].content.parts[0].text;
            // Clean up markdown code blocks if present
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
            const textSpan = document.createElement('span');
            textSpan.className = 'message-text';
            textSpan.textContent = msg.text;
            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.textContent = 'X';
            removeBtn.title = 'Remove message';
            removeBtn.onclick = () => removeMessage(index);
            item.appendChild(textSpan);
            item.appendChild(removeBtn);
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
