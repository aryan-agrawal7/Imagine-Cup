let isSelectionMode = false;
let highlightedElement = null;

console.log('TimingOS: Content script loaded on ' + window.location.hostname);

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

    if (highlightedElement && highlightedElement !== target) {
        highlightedElement.style.outline = '';
    }
    
    highlightedElement = target;
    highlightedElement.style.outline = '2px dashed #9C27B0'; // Purple dashed
    highlightedElement.style.boxShadow = 'inset 0 0 0 2px rgba(156, 39, 176, 0.3)';
}

function handleMouseOut(event) {
    if (!isSelectionMode) return;
    if (event.target === highlightedElement) {
        event.target.style.outline = '';
        event.target.style.boxShadow = '';
        highlightedElement = null;
    }
}

function handleClick(event) {
    if (!isSelectionMode) return;
    
    event.preventDefault();
    event.stopPropagation();
    
    const target = event.target;
    const text = target.innerText.trim();
    
    console.log('TimingOS: Clicked element', target, 'Text:', text);

    if (!text) {
        console.log('TimingOS: No text found in clicked element.');
        return;
    }

    // Visual feedback: Flash solid purple
    const originalBg = target.style.backgroundColor;
    target.style.outline = '3px solid #9C27B0';
    target.style.backgroundColor = 'rgba(156, 39, 176, 0.2)';
    
    setTimeout(() => {
        target.style.backgroundColor = originalBg;
        if (highlightedElement === target) {
            target.style.outline = '2px dashed #9C27B0';
        } else {
            target.style.outline = '';
        }
    }, 300);

    const messageData = {
        id: Date.now().toString(),
        text: text.substring(0, 200), // Truncate for storage safety
        timestamp: new Date().toISOString()
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
