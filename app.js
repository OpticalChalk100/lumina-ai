import { parseMarkdown, copyToClipboard } from './markdown.js';
import { validateToken, queryChatbot, queryChatbotProxy } from './hf-api.js';

// Application State
let sessions = [];
let activeSessionId = null;
let activeAbortController = null;
let isTypingSimulationActive = false;
let typingSimulationTimeout = null;
let serverHasToken = false;

// DOM Elements Cache
const DOM = {
    sidebar: document.getElementById('sidebar'),
    sidebarOverlay: document.getElementById('sidebarOverlay'),
    menuToggle: document.getElementById('menuToggle'),
    
    sessionsList: document.getElementById('sessionsList'),
    btnNewChat: document.getElementById('btnNewChat'),
    btnClearHistory: document.getElementById('btnClearHistory'),
    
    hfToken: document.getElementById('hfToken'),
    btnToggleToken: document.getElementById('btnToggleToken'),
    modelSelector: document.getElementById('modelSelector'),
    customModelGroup: document.getElementById('customModelGroup'),
    customModelId: document.getElementById('customModelId'),
    systemPrompt: document.getElementById('systemPrompt'),
    
    tempSlider: document.getElementById('tempSlider'),
    tempBadge: document.getElementById('tempBadge'),
    tokensSlider: document.getElementById('tokensSlider'),
    tokensBadge: document.getElementById('tokensBadge'),
    
    activeModelTitle: document.getElementById('activeModelTitle'),
    activeModelSubtitle: document.getElementById('activeModelSubtitle'),
    connectionStatusBadge: document.getElementById('connectionStatusBadge'),
    statusText: document.getElementById('statusText'),
    
    messagesViewport: document.getElementById('messagesViewport'),
    welcomeOverlay: document.getElementById('welcomeOverlay'),
    
    chatInput: document.getElementById('chatInput'),
    btnSend: document.getElementById('btnSend'),
    inputWarning: document.getElementById('inputWarning'),
    toastContainer: document.getElementById('toastContainer')
};

// -------------------------------------------------------------
// Toast Notifications System
// -------------------------------------------------------------
function showToast(message, type = 'info', duration = 4000) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let iconName = 'info';
    if (type === 'success') iconName = 'check-circle';
    if (type === 'error') iconName = 'alert-octagon';
    if (type === 'warning') iconName = 'alert-triangle';
    
    toast.innerHTML = `
        <i data-lucide="${iconName}" style="width: 18px; height: 18px; flex-shrink: 0;"></i>
        <div class="toast-message">${message}</div>
        <button class="toast-close">
            <i data-lucide="x" style="width: 14px; height: 14px;"></i>
        </button>
    `;
    
    DOM.toastContainer.appendChild(toast);
    if (window.lucide) window.lucide.createIcons();
    
    // Auto-remove after duration
    const removeTimeout = setTimeout(() => {
        toast.style.animation = 'toastSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards';
        toast.addEventListener('animationend', () => toast.remove());
    }, duration);
    
    // Manual Close
    toast.querySelector('.toast-close').addEventListener('click', () => {
        clearTimeout(removeTimeout);
        toast.style.animation = 'toastSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards';
        toast.addEventListener('animationend', () => toast.remove());
    });
}

// Helper to generate a unique random ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// -------------------------------------------------------------
// Asynchronous API Token Verification
// -------------------------------------------------------------
let tokenVerificationTimeout = null;

// -------------------------------------------------------------
// Server Config Verification
// -------------------------------------------------------------
async function checkServerConfig() {
    try {
        const response = await fetch('/api/config');
        if (response.ok) {
            const data = await response.json();
            serverHasToken = !!data.hasToken;
            if (serverHasToken) {
                DOM.hfToken.placeholder = '•••••••••••••••• (Server Key Active)';
                
                // If there's no stored token in local storage, initialize UI with server key
                const storedToken = localStorage.getItem('hf_chatbot_token');
                if (!storedToken) {
                    DOM.connectionStatusBadge.className = 'status-badge connected';
                    DOM.statusText.textContent = 'Ready (Server Managed)';
                    DOM.btnSend.disabled = false;
                    DOM.inputWarning.classList.remove('visible');
                    
                    const helpText = document.querySelector('.help-text');
                    if (helpText) {
                        helpText.innerHTML = 'Using server-side API Key. You can enter your own to override.';
                    }
                }
            }
        }
    } catch (err) {
        console.warn('Backend configuration check failed. Running in static client-only mode.', err);
    }
}

async function checkTokenValidity(instant = false) {
    let token = DOM.hfToken.value.trim();
    
    // Clean redundant Bearer prefixes if user pasted it directly from tutorial headers
    if (token.toLowerCase().startsWith('bearer ')) {
        token = token.substring(7).trim();
        DOM.hfToken.value = token; // Reflect sanitized token back visually on UI
    }
    
    if (!token) {
        if (serverHasToken) {
            DOM.connectionStatusBadge.className = 'status-badge connected';
            DOM.statusText.textContent = 'Ready (Server Managed)';
            DOM.btnSend.disabled = false;
            DOM.inputWarning.classList.remove('visible');
        } else {
            DOM.connectionStatusBadge.className = 'status-badge';
            DOM.statusText.textContent = 'No Credentials';
            DOM.btnSend.disabled = true;
            DOM.inputWarning.classList.add('visible');
        }
        return;
    }

    // Set UI to testing loading state
    DOM.connectionStatusBadge.className = 'status-badge testing';
    DOM.statusText.textContent = 'Verifying...';
    DOM.inputWarning.classList.remove('visible');

    const runValidation = async () => {
        const result = await validateToken(token);
        
        if (result.isValid) {
            DOM.connectionStatusBadge.className = 'status-badge connected';
            DOM.statusText.textContent = `Connected (${result.username})`;
            DOM.btnSend.disabled = false;
            DOM.inputWarning.classList.remove('visible');
            localStorage.setItem('hf_chatbot_token', token);
        } else {
            DOM.connectionStatusBadge.className = 'status-badge';
            DOM.statusText.textContent = 'Invalid Token';
            DOM.btnSend.disabled = true;
            DOM.inputWarning.classList.add('visible');
            showToast(result.error || 'Token verification failed.', 'error');
        }
    };

    if (instant) {
        await runValidation();
    } else {
        // Debounce typing input calls to save network resources
        clearTimeout(tokenVerificationTimeout);
        tokenVerificationTimeout = setTimeout(runValidation, 800);
    }
}

// -------------------------------------------------------------
// Chat History Session Management
// -------------------------------------------------------------
function saveSessionsToStorage() {
    localStorage.setItem('hf_chatbot_sessions', JSON.stringify(sessions));
    localStorage.setItem('hf_chatbot_active_id', activeSessionId);
}

function loadSessionsFromStorage() {
    const stored = localStorage.getItem('hf_chatbot_sessions');
    const storedActive = localStorage.getItem('hf_chatbot_active_id');
    const savedToken = localStorage.getItem('hf_chatbot_token');
    
    if (savedToken) {
        DOM.hfToken.value = savedToken;
        checkTokenValidity(true);
    }
    
    if (stored) {
        try {
            sessions = JSON.parse(stored);
            activeSessionId = storedActive;
            renderSessionsList();
            
            if (activeSessionId) {
                switchActiveSession(activeSessionId);
            }
        } catch (err) {
            console.error('Error parsing stored chat sessions:', err);
            sessions = [];
            createNewSession();
        }
    } else {
        createNewSession();
    }
}

function createNewSession() {
    // If we have typing streaming going on, abort it first
    abortResponseGeneration();

    const newId = generateId();
    const newSession = {
        id: newId,
        title: 'New Conversation',
        systemPrompt: DOM.systemPrompt.value.trim() || 'You are a helpful coding assistant.',
        messages: []
    };
    
    sessions.unshift(newSession);
    activeSessionId = newId;
    
    saveSessionsToStorage();
    renderSessionsList();
    switchActiveSession(newId);
}

function deleteSession(id, event) {
    if (event) event.stopPropagation(); // Avoid triggering switch active on item selection
    
    sessions = sessions.filter(s => s.id !== id);
    
    if (activeSessionId === id) {
        activeSessionId = sessions.length > 0 ? sessions[0].id : null;
    }
    
    if (!activeSessionId) {
        createNewSession();
    } else {
        saveSessionsToStorage();
        renderSessionsList();
        switchActiveSession(activeSessionId);
    }
    
    showToast('Conversation deleted.', 'info');
}

function renameSession(id, newTitle) {
    const session = sessions.find(s => s.id === id);
    if (session && newTitle.trim() !== '') {
        session.title = newTitle.trim();
        saveSessionsToStorage();
        renderSessionsList();
    }
}

function renderSessionsList() {
    DOM.sessionsList.innerHTML = '';
    
    sessions.forEach(session => {
        const item = document.createElement('div');
        item.className = `session-item ${session.id === activeSessionId ? 'active' : ''}`;
        item.addEventListener('click', () => switchActiveSession(session.id));
        
        item.innerHTML = `
            <div class="session-title-wrapper">
                <i data-lucide="message-square" style="width: 15px; height: 15px; flex-shrink: 0;"></i>
                <span class="session-title">${session.title}</span>
            </div>
            <div class="session-actions">
                <button class="session-action-btn edit" title="Rename convo">
                    <i data-lucide="edit-3" style="width: 12px; height: 12px;"></i>
                </button>
                <button class="session-action-btn delete" title="Delete convo">
                    <i data-lucide="trash" style="width: 12px; height: 12px;"></i>
                </button>
            </div>
        `;
        
        // Setup actions event listeners
        item.querySelector('.edit').addEventListener('click', (e) => {
            e.stopPropagation();
            const currentTitle = session.title;
            const input = document.createElement('input');
            input.type = 'text';
            input.value = currentTitle;
            input.className = 'setting-input';
            input.style.fontSize = '13px';
            input.style.padding = '4px 6px';
            
            const titleSpan = item.querySelector('.session-title');
            titleSpan.replaceWith(input);
            input.focus();
            
            const finishRename = () => {
                renameSession(session.id, input.value);
            };
            
            input.addEventListener('blur', finishRename);
            input.addEventListener('keydown', (kd) => {
                if (kd.key === 'Enter') finishRename();
                if (kd.key === 'Escape') {
                    input.removeEventListener('blur', finishRename);
                    renderSessionsList();
                }
            });
        });
        
        item.querySelector('.delete').addEventListener('click', (e) => deleteSession(session.id, e));
        
        DOM.sessionsList.appendChild(item);
    });
    
    if (window.lucide) window.lucide.createIcons();
}

function switchActiveSession(id) {
    abortResponseGeneration();
    activeSessionId = id;
    
    // Update active visual list element
    const items = DOM.sessionsList.querySelectorAll('.session-item');
    items.forEach(el => el.classList.remove('active'));
    
    const activeItem = Array.from(items).find((_, idx) => sessions[idx] && sessions[idx].id === id);
    if (activeItem) activeItem.classList.add('active');
    
    saveSessionsToStorage();
    renderConversation();
}

// -------------------------------------------------------------
// Message Rendering Engine
// -------------------------------------------------------------
function renderConversation() {
    const session = sessions.find(s => s.id === activeSessionId);
    if (!session) return;
    
    // Clear display
    DOM.messagesViewport.innerHTML = '';
    
    if (session.messages.length === 0) {
        DOM.welcomeOverlay.style.display = 'flex';
        return;
    }
    
    DOM.welcomeOverlay.style.display = 'none';
    
    // Loop through messages and render them
    session.messages.forEach(msg => {
        appendMessageUI(msg.role, msg.content);
    });
    
    scrollToBottom();
}

function appendMessageUI(role, content, isGenerating = false) {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${role}`;
    
    const avatarIcon = role === 'user' ? 'user' : 'bot';
    const parsedHTML = parseMarkdown(content);
    
    wrapper.innerHTML = `
        ${role === 'ai' ? `<div class="message-avatar"><i data-lucide="${avatarIcon}" style="width: 18px; height: 18px;"></i></div>` : ''}
        <div class="message-bubble ${isGenerating ? 'typing-bubble' : ''}">
            ${isGenerating ? '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>' : parsedHTML}
        </div>
        ${role === 'user' ? `<div class="message-avatar" style="background: var(--bg-surface-hover); border: 1px solid var(--border-light); color: var(--accent-violet);"><i data-lucide="${avatarIcon}" style="width: 18px; height: 18px;"></i></div>` : ''}
    `;
    
    DOM.messagesViewport.appendChild(wrapper);
    if (window.lucide) window.lucide.createIcons();
    
    return wrapper;
}

function scrollToBottom() {
    DOM.messagesViewport.scrollTop = DOM.messagesViewport.scrollHeight;
}

// -------------------------------------------------------------
// Asynchronous Stream-like Typing Simulator
// -------------------------------------------------------------
async function simulateResponseTyping(messageWrapper, fullResponseText) {
    isTypingSimulationActive = true;
    const bubble = messageWrapper.querySelector('.message-bubble');
    
    // Remove typing dots layout
    bubble.classList.remove('typing-bubble');
    bubble.innerHTML = '';
    
    // Split text into tokens (words and whitespaces) for realistic reading flow
    const tokens = fullResponseText.split(/(\s+)/);
    let displayedText = '';
    let index = 0;
    
    return new Promise((resolve) => {
        const typeNextToken = () => {
            if (!isTypingSimulationActive || index >= tokens.length) {
                // Formatting clean finish
                bubble.innerHTML = parseMarkdown(fullResponseText);
                if (window.lucide) window.lucide.createIcons();
                scrollToBottom();
                isTypingSimulationActive = false;
                resolve();
                return;
            }
            
            displayedText += tokens[index++];
            bubble.innerHTML = parseMarkdown(displayedText);
            
            // Re-apply Lucide icons that appear inside code copies dynamically
            if (window.lucide) window.lucide.createIcons();
            
            scrollToBottom();
            
            // Adjust delay for realistic natural speed patterns
            const currentToken = tokens[index - 1];
            const isPunctuation = /[.,!?;:]/.test(currentToken);
            const delay = isPunctuation ? 180 : Math.floor(Math.random() * 20) + 12;
            
            typingSimulationTimeout = setTimeout(typeNextToken, delay);
        };
        
        typeNextToken();
    });
}

function abortResponseGeneration() {
    if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
    }
    
    if (isTypingSimulationActive) {
        clearTimeout(typingSimulationTimeout);
        isTypingSimulationActive = false;
    }
    
    // Remove active generating elements
    const lastMessage = DOM.messagesViewport.lastElementChild;
    if (lastMessage && lastMessage.classList.contains('ai') && lastMessage.querySelector('.typing-bubble')) {
        lastMessage.remove();
    }
    
    setGeneratingStateUI(false);
}

// -------------------------------------------------------------
// Core AI Prompter Engine
// -------------------------------------------------------------
async function handleSendPrompt(customPrompt = null) {
    const promptText = customPrompt || DOM.chatInput.value.trim();
    if (!promptText) return;
    
    const token = DOM.hfToken.value.trim();
    if (!token && !serverHasToken) {
        showToast('Please configure your Hugging Face Token in Settings first!', 'warning');
        DOM.sidebar.classList.add('open');
        DOM.sidebarOverlay.classList.add('active');
        return;
    }
    
    const session = sessions.find(s => s.id === activeSessionId);
    if (!session) return;
    
    // Clear textarea
    if (!customPrompt) {
        DOM.chatInput.value = '';
        DOM.chatInput.style.height = 'auto';
    }
    
    DOM.welcomeOverlay.style.display = 'none';
    
    // 1. Append User Message
    session.messages.push({ role: 'user', content: promptText });
    appendMessageUI('user', promptText);
    scrollToBottom();
    
    // Update session title if default
    if (session.title === 'New Conversation') {
        const titleWords = promptText.split(/\s+/).slice(0, 4).join(' ');
        session.title = titleWords + (promptText.split(/\s+/).length > 4 ? '...' : '');
        renderSessionsList();
    }
    
    // 2. Setup AI Response Loading UI
    setGeneratingStateUI(true);
    const aiMessageWrapper = appendMessageUI('ai', '', true); // starts with bouncing dots
    scrollToBottom();
    
    // 3. Initiate Asynchronous Query
    activeAbortController = new AbortController();
    
    // Gather details
    let modelId = DOM.modelSelector.value;
    if (modelId === 'custom') {
        modelId = DOM.customModelId.value.trim() || 'meta-llama/Meta-Llama-3-8B-Instruct';
    }
    
    const systemPrompt = DOM.systemPrompt.value.trim() || 'You are Lumina, a brilliant AI chatbot.';
    const temperature = parseFloat(DOM.tempSlider.value);
    const maxTokens = parseInt(DOM.tokensSlider.value);
    
    // Update header statuses
    DOM.activeModelSubtitle.textContent = 'Generating...';
    
    try {
        let responseContent;
        if (!token && serverHasToken) {
            responseContent = await queryChatbotProxy({
                modelId,
                systemPrompt,
                messages: session.messages,
                temperature,
                maxTokens,
                signal: activeAbortController.signal
            });
        } else {
            responseContent = await queryChatbot({
                token,
                modelId,
                systemPrompt,
                messages: session.messages,
                temperature,
                maxTokens,
                signal: activeAbortController.signal,
                onWarmUp: (seconds) => {
                    DOM.activeModelSubtitle.textContent = `Warming up model (${seconds}s remaining)...`;
                    showToast(`Serverless model is loading on Hugging Face. Retrying in background...`, 'warning', 3000);
                }
            });
        }
        
        // Complete query safely
        activeAbortController = null;
        DOM.activeModelSubtitle.textContent = 'Typing response...';
        
        // 4. Trigger typing animation simulation
        await simulateResponseTyping(aiMessageWrapper, responseContent);
        
        // 5. Save AI response back to session logs
        session.messages.push({ role: 'ai', content: responseContent });
        saveSessionsToStorage();
        
    } catch (err) {
        if (err.name === 'AbortError') {
            console.log('Prompt execution cancelled by user.');
            showToast('Response generation stopped.', 'info');
            return;
        }
        
        console.error('AI Request Failure:', err);
        
        // Remove typing bubble and render error card
        aiMessageWrapper.remove();
        
        const errorContent = `**System Error Encountered**:\n\n> <i data-lucide="alert-octagon" style="color: var(--accent-rose); width: 14px; height: 14px; display: inline-block;"></i> ${err.message || 'An unknown network error occurred.'}\n\nPlease check your internet connection, API Key permission, or choose a lighter model from settings.`;
        
        session.messages.push({ role: 'ai', content: errorContent });
        appendMessageUI('ai', errorContent);
        saveSessionsToStorage();
        showToast('Inference prompt failed. Review error message.', 'error');
        
    } finally {
        setGeneratingStateUI(false);
        DOM.activeModelSubtitle.textContent = 'Ready';
        activeAbortController = null;
    }
}

function setGeneratingStateUI(isGenerating) {
    if (isGenerating) {
        DOM.btnSend.innerHTML = '<i data-lucide="square" style="width: 18px; height: 18px; color: var(--accent-rose);"></i>';
        DOM.btnSend.title = 'Stop generating response';
        DOM.btnSend.disabled = false;
    } else {
        DOM.btnSend.innerHTML = '<i data-lucide="send" style="width: 18px; height: 18px;"></i>';
        DOM.btnSend.title = 'Send message';
        
        // Disable send only if token and server key are both empty
        const token = DOM.hfToken.value.trim();
        DOM.btnSend.disabled = !token && !serverHasToken;
    }
    
    if (window.lucide) window.lucide.createIcons();
}

// -------------------------------------------------------------
// Event Listener Setups & Bindings
// -------------------------------------------------------------
function setupEventListeners() {
    
    // Toggle Mobile Sidebar Drawer
    DOM.menuToggle.addEventListener('click', () => {
        DOM.sidebar.classList.toggle('open');
        DOM.sidebarOverlay.classList.toggle('active');
    });
    
    DOM.sidebarOverlay.addEventListener('click', () => {
        DOM.sidebar.classList.remove('open');
        DOM.sidebarOverlay.classList.remove('active');
    });
    
    // New conversation trigger
    DOM.btnNewChat.addEventListener('click', () => {
        createNewSession();
        // Automatically collapse sidebar drawer on mobile after selection
        DOM.sidebar.classList.remove('open');
        DOM.sidebarOverlay.classList.remove('active');
        showToast('Created new conversation thread.', 'success');
    });
    
    // Clear all conversations trigger
    DOM.btnClearHistory.addEventListener('click', () => {
        if (confirm('Are you sure you want to permanently delete ALL conversation threads? This cannot be undone.')) {
            sessions = [];
            activeSessionId = null;
            createNewSession();
            showToast('All conversation logs cleared.', 'info');
        }
    });
    
    // Credentials & API Fields listeners
    DOM.hfToken.addEventListener('input', () => checkTokenValidity(false));
    
    DOM.btnToggleToken.addEventListener('click', () => {
        const isPassword = DOM.hfToken.type === 'password';
        DOM.hfToken.type = isPassword ? 'text' : 'password';
        const icon = DOM.btnToggleToken.querySelector('i');
        
        if (icon) {
            icon.setAttribute('data-lucide', isPassword ? 'eye-off' : 'eye');
            if (window.lucide) window.lucide.createIcons();
        }
    });
    
    // Model Selector Logic
    DOM.modelSelector.addEventListener('change', () => {
        const val = DOM.modelSelector.value;
        if (val === 'custom') {
            DOM.customModelGroup.style.display = 'block';
            DOM.activeModelTitle.textContent = 'Custom LLM';
        } else {
            DOM.customModelGroup.style.display = 'none';
            // Display formatted shortname in header
            const shortName = val.split('/').pop();
            DOM.activeModelTitle.textContent = shortName;
        }
    });
    
    DOM.customModelId.addEventListener('input', () => {
        DOM.activeModelTitle.textContent = DOM.customModelId.value.trim() || 'Custom LLM';
    });
    
    // Parameter badge trackers
    DOM.tempSlider.addEventListener('input', () => {
        DOM.tempBadge.textContent = DOM.tempSlider.value;
    });
    
    DOM.tokensSlider.addEventListener('input', () => {
        DOM.tokensBadge.textContent = DOM.tokensSlider.value;
    });
    
    // Textarea keystrokes and autogrow
    DOM.chatInput.addEventListener('input', () => {
        DOM.chatInput.style.height = 'auto';
        DOM.chatInput.style.height = DOM.chatInput.scrollHeight + 'px';
    });
    
    DOM.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (activeAbortController || isTypingSimulationActive) {
                // If generating, Enter does nothing
                return;
            }
            handleSendPrompt();
        }
    });
    
    // Send / Cancel Action Click triggers
    DOM.btnSend.addEventListener('click', () => {
        if (activeAbortController || isTypingSimulationActive) {
            abortResponseGeneration();
        } else {
            handleSendPrompt();
        }
    });
    
    // Quick prompt buttons listeners
    document.querySelectorAll('.quick-prompt-card').forEach(card => {
        card.addEventListener('click', () => {
            const prompt = card.getAttribute('data-prompt');
            const token = DOM.hfToken.value.trim();
            
            if (!token && !serverHasToken) {
                showToast('Please add a Hugging Face API key in Settings first.', 'warning');
                DOM.sidebar.classList.add('open');
                DOM.sidebarOverlay.classList.add('active');
                DOM.hfToken.focus();
                return;
            }
            
            handleSendPrompt(prompt);
        });
    });
    
    // Event delegation for dynamically parsed code copy buttons inside main viewport
    DOM.messagesViewport.addEventListener('click', async (e) => {
        const copyBtn = e.target.closest('.btn-copy-code');
        if (copyBtn) {
            const code = copyBtn.getAttribute('data-code');
            await copyToClipboard(code, copyBtn);
            showToast('Code snippet copied to clipboard!', 'success', 2000);
        }
    });
}

// -------------------------------------------------------------
// Application Initializer
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Initialize Lucide elements
    if (window.lucide) window.lucide.createIcons();
    
    // 2. Set default active model header title
    const activeModel = DOM.modelSelector.value;
    DOM.activeModelTitle.textContent = activeModel.split('/').pop();
    
    // 3. Bind UI interactions
    setupEventListeners();
    
    // 4. Check for server configuration first
    await checkServerConfig();
    
    // 5. Reload saved local histories and configs
    loadSessionsFromStorage();
});
