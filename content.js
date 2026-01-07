let isSelectionMode = false;
let highlightedElement = null;

console.log('TimingOS: Content script loaded on ' + window.location.hostname);

// --- SNAPPARSERS: Platform-Specific Logic ---
const SNAPPARSERS = {
    // SLACK
    'app.slack.com': {
        rowSelector: '.c-message_kit__gutter', // The main message row
        getText: (el) => {
             const content = el.querySelector('[data-qa="message_content"]') || 
                             el.querySelector('.c-message_kit__blocks__rich_text');
             return content ? content.innerText : el.innerText;
        },
        getSender: (el) => el.querySelector('.c-message__sender')?.innerText || "Unknown",
        getTimestamp: (el) => {
            // Try to find the timestamp link/label
            const tsNode = el.querySelector('.c-timestamp');
            if (tsNode) {
                 // Common Slack format in aria-label: "Today at 2:30 PM" or timestamp in data-ts attribute
                 const dataTs = tsNode.parentElement?.getAttribute('data-ts');
                 if (dataTs) return new Date(parseFloat(dataTs) * 1000).toISOString();
                 return tsNode.getAttribute('aria-label') || tsNode.innerText;
            }
            return new Date().toISOString(); // Fallback
        },
        isMe: (el) => {
             // Slack doesn't always mark "me" clearly in class without digging.
             // But we can sometimes check if it doesn't have a sender name (grouped) 
             // or check specific user attributes if available. 
             // For now, return null to let the user decide or backend infer.
             return false; 
        }
    },

    // WHATSAPP WEB
    'web.whatsapp.com': {
        rowSelector: 'div[role="row"]', // Matches the message row
        getText: (el) => el.querySelector('.copyable-text span')?.innerText || el.innerText,
        getSender: (el) => {
            // Check for message-out (Me) vs message-in (Them)
            const container = el.querySelector('div.message-out, div.message-in');
            if (container) {
                return container.classList.contains('message-out') ? "Me" : "Them";
            }
            return "Unknown";
        },
        getTimestamp: (el) => {
            // WhatsApp often puts metadata in data-pre-plain-text
            const metaNode = el.querySelector('div[data-pre-plain-text]');
            if (metaNode) {
                const raw = metaNode.getAttribute('data-pre-plain-text');
                console.log('TimingOS Debug: Raw extracted timestamp:', raw);
                const match = raw.match(/\[(.*?)\]/);
                if (match) {
                    // Remove specialized LTR/RTL markers and invisible chars
                    const tsStr = match[1].replace(/[\u200E\u200F\u202A-\u202E]/g, '').trim(); 
                    
                    // Custom parsing for WhatsApp Web "HH:mm, DD/MM/YYYY" format (e.g. "19:36, 07/01/2026")
                    // The standard Date() constructor often defaults to MM/DD/YYYY which causes errors for 
                    // international users (converting 07/01 to July 1st instead of Jan 7th).
                    const parts = tsStr.split(',').map(s => s.trim());
                    if (parts.length === 2) {
                        const timePart = parts[0];
                        const datePart = parts[1];

                        // Check if it matches "HH:mm" and "DD/MM/YYYY" pattern
                        if (timePart.includes(':') && datePart.includes('/') && datePart.split('/').length === 3) {
                            const [dayStr, monthStr, yearStr] = datePart.split('/');
                            const [hourStr, minuteStr] = timePart.split(':');
                            
                            const year = parseInt(yearStr, 10);
                            const month = parseInt(monthStr, 10) - 1; // Month is 0-indexed
                            const day = parseInt(dayStr, 10);
                            const hour = parseInt(hourStr, 10);
                            const minute = parseInt(minuteStr, 10);

                            // Construct date manually to ensure DD/MM interpretation
                            const manualDate = new Date(year, month, day, hour, minute);
                            if (!isNaN(manualDate.getTime())) {
                                return manualDate.toISOString();
                            }
                        }
                    }

                    // Fallback to standard parsing if custom format didn't match
                    let date = new Date(tsStr);
                    if (isNaN(date.getTime())) {
                        // Original fallback logic for other formats
                        if (parts.length === 2 && parts[1].includes('/')) {
                             // Try MM/DD/YYYY first (standard JS)
                            let tryDate = new Date(`${parts[1]} ${parts[0]}`);
                            if (!isNaN(tryDate.getTime())) {
                                date = tryDate;
                            }
                        }
                    }

                    if (!isNaN(date.getTime())) {
                        return date.toISOString();
                    }
                    console.warn('TimingOS: Could not parse WhatsApp date:', tsStr);
                }
            }
            // Absolute fallback
            return new Date().toISOString(); 
        },
        isMe: (el) => !!el.querySelector('div.message-out')
    },

    // LINKEDIN
    'www.linkedin.com': {
        rowSelector: 'li.msg-s-message-list__event', // The list item
        getText: (el) => el.querySelector('.msg-s-event__content')?.innerText || el.innerText,
        getSender: (el) => {
            if (el.classList.contains('msg-s-message-list__event--mine')) return "Me";
            if (el.classList.contains('msg-s-message-list__event--other')) return "Them";
            return "Unknown";
        },
        getTimestamp: (el) => {
            const timeParams = el.querySelector('time')?.innerText;
            return timeParams || new Date().toISOString();
        },
        isMe: (el) => el.classList.contains('msg-s-message-list__event--mine')
    }
};

function getParser() {
    const host = window.location.hostname;
    // Simple matching or defaults
    if (host.includes('slack')) return SNAPPARSERS['app.slack.com'];
    if (host.includes('whatsapp')) return SNAPPARSERS['web.whatsapp.com'];
    if (host.includes('linkedin')) return SNAPPARSERS['www.linkedin.com'];
    return null; // No smart parser for other sites
}

// Initialize state from storage
chrome.storage.local.get(['selectionMode'], (result) => {
    if (result.selectionMode) {
        enableSelectionMode();
    }
});

// Listen for storage changes to toggle mode
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.selectionMode) {
        if (changes.selectionMode.newValue) {
            enableSelectionMode();
        } else {
            disableSelectionMode();
        }
    }
});

function enableSelectionMode() {
    if (isSelectionMode) return;
    isSelectionMode = true;
    document.body.style.cursor = 'pointer';
    document.addEventListener('mouseover', handleMouseOver);
    document.addEventListener('mouseout', handleMouseOut);
    document.addEventListener('click', handleClick, true); // Capture phase
    console.log('TimingOS: Selection Mode Enabled');
}

function disableSelectionMode() {
    if (!isSelectionMode) return;
    isSelectionMode = false;
    document.body.style.cursor = '';
    document.removeEventListener('mouseover', handleMouseOver);
    document.removeEventListener('mouseout', handleMouseOut);
    document.removeEventListener('click', handleClick, true);
    
    if (highlightedElement) {
        highlightedElement.style.outline = '';
        highlightedElement = null;
    }
    console.log('TimingOS: Selection Mode Disabled');
}

function handleMouseOver(event) {
    if (!isSelectionMode) return;
    const target = event.target;
    
    // Avoid highlighting the body or html
    if (target === document.body || target === document.documentElement) return;

    let elementToHighlight = target;
    const parser = getParser();

    if (parser) {
        // Smart Selection: Find the closest container
        const container = target.closest(parser.rowSelector);
        if (container) {
            elementToHighlight = container;
        } else {
            // If we are on a supported platform but not hovering a message, 
            // maybe don't highlight anything to reduce noise?
            // For now, let's just ignore non-message elements on these platforms
            if (highlightedElement) {
                highlightedElement.style.outline = '';
                highlightedElement = null;
            }
            return; 
        }
    }

    if (highlightedElement && highlightedElement !== elementToHighlight) {
        highlightedElement.style.outline = '';
        highlightedElement.style.boxShadow = '';
    }
    
    highlightedElement = elementToHighlight;
    highlightedElement.style.outline = '2px dashed #9C27B0'; // Purple dashed
    highlightedElement.style.boxShadow = 'inset 0 0 0 2px rgba(156, 39, 176, 0.3)';
    highlightedElement.style.cursor = 'crosshair';
}

function handleMouseOut(event) {
    if (!isSelectionMode) return;
    
    // We handle the cleanup in mouseOver mostly, but to be safe:
    // Only clear if we are actually leaving the highlighted element (not entering a child)
    if (highlightedElement && !highlightedElement.contains(event.relatedTarget)) {
         highlightedElement.style.outline = '';
         highlightedElement.style.boxShadow = '';
         highlightedElement = null;
    }
}

function handleClick(event) {
    if (!isSelectionMode) return;
    
    // If we have a highlighted element (smart selected), use that. Otherwise use target.
    const target = highlightedElement || event.target;

    event.preventDefault();
    event.stopPropagation();
    
    // Default extraction
    let text = target.innerText.trim();
    let sender = "Unknown";
    let timestamp = new Date().toISOString(); 
    let isMe = false;

    // Smart Extraction
    const parser = getParser();
    if (parser && target.matches(parser.rowSelector)) {
        text = parser.getText(target);
        sender = parser.getSender(target);
        timestamp = parser.getTimestamp(target);
        isMe = parser.isMe(target);
        
        console.log(`TimingOS Smart Capture [${window.location.hostname}]:`, { text, sender, timestamp });
    } else {
        console.log('TimingOS: Default Clicked element', target, 'Text:', text);
    }

    if (!text) {
        console.log('TimingOS: No text found in clicked element.');
        return;
    }

    // Visual feedback: Flash solid purple
    const originalBg = target.style.backgroundColor;
    target.style.transition = 'background-color 0.2s';
    target.style.backgroundColor = 'rgba(156, 39, 176, 0.2)';
    
    setTimeout(() => {
        target.style.backgroundColor = originalBg;
    }, 300);

    const messageData = {
        id: Date.now().toString(),
        text: text, // Normalized text
        sender: sender,
        timestamp: timestamp,
        isMe: isMe,
        platform: window.location.hostname
    };

    // Save to storage
    chrome.storage.local.get(['messages'], (result) => {
        const messages = result.messages || [];
        messages.push(messageData);
        chrome.storage.local.set({ messages: messages }, () => {
            console.log('TimingOS: Message captured', messageData);
        });
    });
}
