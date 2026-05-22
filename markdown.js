/**
 * Lumina AI Markdown & Code Highlighting Parser
 * A highly-customized, lightweight, and robust parser to securely render AI responses.
 */

// Simple regular expressions for syntax highlighting
const SYNTAX_RULES = {
    keyword: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|import|export|from|class|extends|new|async|await|try|catch|finally|throw|typeof|instanceof|in|of|void|debugger|yield)\b/g,
    string: /(["'`])(.*?)\1/g,
    number: /\b(\d+(?:\.\d+)?)\b/g,
    comment: /(\/\/.*|\/\*[\s\S]*?\*\/)/g,
    function: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*\()/g,
    className: /\b([A-Z][a-zA-Z0-9_$]*)\b/g
};

/**
 * Highlights a block of code based on a simplified regex system.
 * @param {string} code - Raw code string
 * @param {string} lang - Code language
 * @returns {string} Highlighted HTML code
 */
function highlightCode(code, lang) {
    let html = code;

    // Apply syntax highlighting rules by wrapping matching tokens in styled spans
    // Ensure we process strings and comments first to prevent keywords inside strings/comments from being highlighted
    const placeholders = [];
    let placeholderCounter = 0;

    // 1. Comments placeholder
    html = html.replace(SYNTAX_RULES.comment, (match) => {
        const id = `___COMMENT_PH_${placeholderCounter++}___`;
        placeholders.push({ id, html: `<span class="code-token-comment">${match}</span>` });
        return id;
    });

    // 2. Strings placeholder
    html = html.replace(SYNTAX_RULES.string, (match) => {
        const id = `___STRING_PH_${placeholderCounter++}___`;
        placeholders.push({ id, html: `<span class="code-token-string">${match}</span>` });
        return id;
    });

    // 3. Highlight numbers
    html = html.replace(SYNTAX_RULES.number, '<span class="code-token-number">$1</span>');

    // 4. Highlight keywords
    html = html.replace(SYNTAX_RULES.keyword, '<span class="code-token-keyword">$1</span>');

    // 5. Highlight class/objects
    html = html.replace(SYNTAX_RULES.className, '<span class="code-token-className">$1</span>');

    // 6. Highlight function calls
    html = html.replace(SYNTAX_RULES.function, '<span class="code-token-function">$1</span>');

    // Restore comments and strings placeholders
    for (const ph of placeholders) {
        html = html.replace(ph.id, ph.html);
    }

    return html;
}

/**
 * Safely parses raw markdown into styled HTML strings, handling syntax highlighted code blocks.
 * @param {string} text - Raw Markdown response
 * @returns {string} Safe HTML representation
 */
export function parseMarkdown(text) {
    if (!text) return '';

    // Step 1: Escape HTML tags to protect against Cross-Site Scripting (XSS)
    let sanitized = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Step 2: Extract code blocks first so markdown selectors do not affect inside-code styling
    const codeBlocks = [];
    let blockCounter = 0;
    
    // Regular expression for code blocks
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    
    sanitized = sanitized.replace(codeBlockRegex, (match, lang, code) => {
        const placeholder = `__CODE_BLOCK_PLACEHOLDER_${blockCounter++}__`;
        const language = lang || 'code';
        const rawCode = code.trim();
        const highlighted = highlightCode(rawCode, language);

        // Build premium terminal-like container for the code block
        const containerHTML = `
            <div class="code-block-container">
                <div class="code-block-header">
                    <div class="code-mac-controls">
                        <div class="code-mac-dot red"></div>
                        <div class="code-mac-dot yellow"></div>
                        <div class="code-mac-dot green"></div>
                    </div>
                    <div class="code-meta">
                        <span class="code-lang-label">${language}</span>
                        <button class="btn-copy-code" data-code="${encodeURIComponent(rawCode)}" title="Copy code snippet">
                            <i data-lucide="copy" style="width: 12px; height: 12px;"></i>
                            <span>Copy</span>
                        </button>
                    </div>
                </div>
                <pre class="code-block-pre"><code class="code-block-code lang-${language}">${highlighted}</code></pre>
            </div>
        `;
        
        codeBlocks.push({ placeholder, html: containerHTML });
        return placeholder;
    });

    // Step 3: Handle typical inline styling rules (bold, italics, inline code)
    // Bold: **text** or __text__
    sanitized = sanitized.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    sanitized = sanitized.replace(/__(.*?)__/g, '<strong>$1</strong>');
    
    // Italics: *text* or _text_
    sanitized = sanitized.replace(/\*(.*?)\*/g, '<em>$1</em>');
    sanitized = sanitized.replace(/_(.*?)_/g, '<em>$1</em>');

    // Inline Code: `code`
    sanitized = sanitized.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Step 4: Handle paragraphs, line breaks and lists
    const lines = sanitized.split('\n');
    let parsedContent = '';
    let inList = false;
    let listType = null; // 'ul' or 'ol'
    let currentParagraph = [];

    const closeListIfNeeded = () => {
        if (inList) {
            parsedContent += `</${listType}>`;
            inList = false;
            listType = null;
        }
    };

    const flushParagraph = () => {
        if (currentParagraph.length > 0) {
            parsedContent += `<p>${currentParagraph.join('<br>')}</p>`;
            currentParagraph = [];
        }
    };

    for (let line of lines) {
        const trimmed = line.trim();

        // If it's a code block placeholder, flush paragraph, close list, and output direct placeholder
        if (trimmed.startsWith('__CODE_BLOCK_PLACEHOLDER_') && trimmed.endsWith('__')) {
            closeListIfNeeded();
            flushParagraph();
            parsedContent += trimmed + '\n';
            continue;
        }

        // Empty line signifies block separation
        if (trimmed === '') {
            closeListIfNeeded();
            flushParagraph();
            continue;
        }

        // Unordered List Match: - item or * item
        const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
        // Ordered List Match: 1. item
        const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);

        if (ulMatch) {
            flushParagraph();
            if (!inList || listType !== 'ul') {
                closeListIfNeeded();
                parsedContent += '<ul>';
                inList = true;
                listType = 'ul';
            }
            parsedContent += `<li>${ulMatch[2]}</li>`;
        } else if (olMatch) {
            flushParagraph();
            if (!inList || listType !== 'ol') {
                closeListIfNeeded();
                parsedContent += '<ol>';
                inList = true;
                listType = 'ol';
            }
            parsedContent += `<li>${olMatch[2]}</li>`;
        } else {
            // General text paragraph
            closeListIfNeeded();
            currentParagraph.push(line);
        }
    }

    // Flush any remaining active structural blocks at EOF
    closeListIfNeeded();
    flushParagraph();

    // Step 5: Restore extracted Code Block containers
    for (const block of codeBlocks) {
        parsedContent = parsedContent.replace(block.placeholder, block.html);
    }

    return parsedContent;
}

/**
 * Handles copies of code blocks safely.
 * @param {string} encodedCode - URI encoded code snippet
 * @param {HTMLElement} copyBtn - Copy trigger button
 */
export async function copyToClipboard(encodedCode, copyBtn) {
    try {
        const decoded = decodeURIComponent(encodedCode);
        await navigator.clipboard.writeText(decoded);
        
        // Show active visual feedback
        const label = copyBtn.querySelector('span');
        const icon = copyBtn.querySelector('i');
        
        if (label) label.textContent = 'Copied!';
        if (icon) {
            icon.setAttribute('data-lucide', 'check');
            if (window.lucide) window.lucide.createIcons();
        }
        
        copyBtn.style.color = 'var(--accent-emerald)';
        
        setTimeout(() => {
            if (label) label.textContent = 'Copy';
            if (icon) {
                icon.setAttribute('data-lucide', 'copy');
                if (window.lucide) window.lucide.createIcons();
            }
            copyBtn.style.color = '';
        }, 2000);
        
    } catch (err) {
        console.error('Clipboard copy failed: ', err);
    }
}
